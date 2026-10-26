package com.pocketcode.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;

import androidx.activity.result.ActivityResult;
import androidx.core.view.WindowCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;

/** 背景只复制到 no_backup/appearance，不进入系统云备份，不保留相册 URI。 */
@CapacitorPlugin(name = "PocketCodeBackground")
public class PocketCodeBackgroundPlugin extends Plugin {
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private File imageFile() { return new File(getContext().getNoBackupFilesDir(), "appearance/background.jpg"); }

    @PluginMethod
    public void choose(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("正在处理背景图片，请稍候"); return; }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivityForResult(call, intent, "imageSelected"); }
        catch (Exception error) { busy.set(false); call.reject("无法打开系统图片选择器", error); }
    }

    @ActivityCallback
    private void imageSelected(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (uri == null) { busy.set(false); JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return; }
        new Thread(() -> {
            File source = null;
            File pending = null;
            Bitmap decoded = null;
            Bitmap oriented = null;
            Bitmap scaled = null;
            Bitmap opaque = null;
            try {
                source = File.createTempFile("background-source-", ".tmp", getContext().getCacheDir());
                // 流式复制并限制输入大小；绝不把原图 base64 通过 JS 桥传递。
                try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                     FileOutputStream out = new FileOutputStream(source)) {
                    if (in == null) throw new Exception("无法读取这张图片");
                    byte[] buffer = new byte[32768];
                    long total = 0;
                    int count;
                    while ((count = in.read(buffer)) != -1) {
                        total += count;
                        if (total > 64L * 1024 * 1024) throw new Exception("请选择小于 64 MB 的图片");
                        out.write(buffer, 0, count);
                    }
                }
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inJustDecodeBounds = true;
                BitmapFactory.decodeFile(source.getAbsolutePath(), options);
                if (options.outWidth <= 0 || options.outHeight <= 0) throw new Exception("图片格式不受支持，请选择 JPG、PNG 或 WebP");
                options.inJustDecodeBounds = false;
                options.inSampleSize = 1;
                while ((long) Math.max(options.outWidth, options.outHeight) / options.inSampleSize > 2560) options.inSampleSize *= 2;
                decoded = BitmapFactory.decodeFile(source.getAbsolutePath(), options);
                if (decoded == null) throw new Exception("图片解码失败");
                Matrix matrix = new Matrix();
                try {
                    int orientation = new ExifInterface(source.getAbsolutePath()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
                    switch (orientation) {
                        case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: matrix.setScale(-1, 1); break;
                        case ExifInterface.ORIENTATION_ROTATE_180: matrix.setRotate(180); break;
                        case ExifInterface.ORIENTATION_FLIP_VERTICAL: matrix.setScale(1, -1); break;
                        case ExifInterface.ORIENTATION_TRANSPOSE: matrix.setRotate(90); matrix.postScale(-1, 1); break;
                        case ExifInterface.ORIENTATION_ROTATE_90: matrix.setRotate(90); break;
                        case ExifInterface.ORIENTATION_TRANSVERSE: matrix.setRotate(270); matrix.postScale(-1, 1); break;
                        case ExifInterface.ORIENTATION_ROTATE_270: matrix.setRotate(270); break;
                        default: break;
                    }
                } catch (Exception ignored) { /* 无 EXIF 的 PNG/WebP 直接使用解码方向。 */ }
                oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.getWidth(), decoded.getHeight(), matrix, true);
                float ratio = Math.min(1f, 1920f / Math.max(oriented.getWidth(), oriented.getHeight()));
                scaled = Bitmap.createScaledBitmap(oriented, Math.max(1, Math.round(oriented.getWidth() * ratio)), Math.max(1, Math.round(oriented.getHeight() * ratio)), true);
                opaque = Bitmap.createBitmap(scaled.getWidth(), scaled.getHeight(), Bitmap.Config.RGB_565);
                Canvas canvas = new Canvas(opaque);
                canvas.drawColor(Color.WHITE); canvas.drawBitmap(scaled, 0, 0, null);
                File target = imageFile();
                File parent = target.getParentFile();
                if (!parent.isDirectory() && !parent.mkdirs()) throw new Exception("无法创建背景存储目录");
                pending = File.createTempFile("background-", ".tmp", parent);
                try (FileOutputStream out = new FileOutputStream(pending)) {
                    if (!opaque.compress(Bitmap.CompressFormat.JPEG, 85, out)) throw new Exception("图片压缩失败");
                    out.flush(); out.getFD().sync();
                }
                // 同目录原子替换：失败时保留旧背景。
                android.system.Os.rename(pending.getAbsolutePath(), target.getAbsolutePath());
                resolveCurrent(call);
            } catch (OutOfMemoryError error) { call.reject("图片过大，设备内存不足，请换一张较小的图片"); }
              catch (Exception error) { call.reject("背景导入失败：" + error.getMessage(), error); }
            finally {
                if (opaque != null) opaque.recycle();
                if (scaled != null && scaled != oriented) scaled.recycle();
                if (oriented != null && oriented != decoded) oriented.recycle();
                if (decoded != null) decoded.recycle();
                if (source != null) source.delete();
                if (pending != null) pending.delete();
                busy.set(false);
            }
        }, "pocketcode-background").start();
    }
    private void resolveCurrent(PluginCall call) {
        File file = imageFile();
        JSObject value = new JSObject();
        if (file.isFile()) { value.put("path", file.getAbsolutePath()); value.put("revision", file.lastModified()); }
        call.resolve(value);
    }
    @PluginMethod public void current(PluginCall call) { resolveCurrent(call); }
    @PluginMethod public void systemTheme(PluginCall call) {
        boolean light = call.getBoolean("light", false);
        getActivity().runOnUiThread(() -> {
            android.view.Window window = getActivity().getWindow();
            WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightStatusBars(light);
            WindowCompat.getInsetsController(window, window.getDecorView()).setAppearanceLightNavigationBars(light);
            int color = Color.parseColor(light ? "#f6f3ec" : "#23262a");
            window.setStatusBarColor(color); window.setNavigationBarColor(color);
            call.resolve();
        });
    }
    @PluginMethod public void clear(PluginCall call) {
        if (!busy.compareAndSet(false, true)) { call.reject("正在处理背景图片，请稍候"); return; }
        try {
            File file = imageFile();
            if (file.exists() && !file.delete()) { call.reject("无法清除背景图片"); return; }
            call.resolve();
        } finally { busy.set(false); }
    }
}
