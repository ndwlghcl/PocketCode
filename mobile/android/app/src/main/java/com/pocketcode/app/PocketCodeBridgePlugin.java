package com.pocketcode.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Iterator;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLHandshakeException;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * PocketCodeBridge：手机端与电脑通信的唯一原生通道。
 *
 * - request(): HTTPS 请求。带 expectedFingerprint 时执行证书指纹绑定
 *   （证书 SHA-256 匹配即身份成立，豁免主机名校验——架构文档 §3.1 的设计）；
 *   不带指纹时仅允许 /v1/health 诊断（无凭据、无敏感数据，且必须仍走 TLS）。
 * - secureSet/secureGet/secureRemove(): EncryptedSharedPreferences 安全存储，
 *   device_token 等敏感值不得落入明文（ADR-0002）。
 */
@CapacitorPlugin(name = "PocketCodeBridge")
public class PocketCodeBridgePlugin extends Plugin {

    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

    private SharedPreferences securePrefs = null;
    private DiskKeyValueStore diskStore = null;

    // ---------------------------------------------------------------- HTTP
    @PluginMethod
    public void request(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String fingerprint = call.getString("fingerprint", null);
        String body = call.getString("body", null);
        int timeoutMs = call.getInt("timeoutMs", 8000);
        JSObject headers = call.getObject("headers");

        if (!url.startsWith("https://")) {
            call.reject("仅允许 https:// 地址（明文已在 S2 移除）", "ERR_INSECURE");
            return;
        }
        if ((fingerprint == null || fingerprint.isEmpty())
                && !url.split("\\?")[0].endsWith("/v1/health")) {
            call.reject("未验证证书指纹时只允许访问 /v1/health 诊断接口", "ERR_NO_FINGERPRINT");
            return;
        }

        // 插件方法运行在 Capacitor 后台线程；再开工作线程执行阻塞 IO，
        // 结果直接 resolve（Capacitor 负责跨线程投递回 WebView）。
        new Thread(() -> {
            AtomicBoolean fingerprintMismatch = new AtomicBoolean(false);
            try {
                URL target = new URL(url);
                HttpsURLConnection connection = (HttpsURLConnection) target.openConnection();
                connection.setConnectTimeout(timeoutMs);
                connection.setReadTimeout(timeoutMs);
                connection.setRequestMethod(method);
                connection.setSSLSocketFactory(sslFactoryFor(fingerprint, fingerprintMismatch));
                connection.setHostnameVerifier(trustingHostnameVerifier());

                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        if ("content-length".equalsIgnoreCase(key)) continue;
                        connection.setRequestProperty(key, headers.getString(key));
                    }
                }
                if (body != null && !method.equals("GET") && !method.equals("HEAD")) {
                    connection.setDoOutput(true);
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    connection.getOutputStream().write(bytes);
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 400
                        ? connection.getErrorStream() : connection.getInputStream();
                String responseBody = stream == null ? "" : readCapped(stream);
                connection.disconnect();

                JSObject result = new JSObject();
                result.put("status", status);
                result.put("body", responseBody);
                call.resolve(result);
            } catch (SSLHandshakeException e) {
                if (fingerprintMismatch.get()) {
                    call.reject("电脑证书指纹不匹配，已拒绝连接", "ERR_TLS");
                } else {
                    call.reject("TLS 握手失败: " + e.getMessage(), "ERR_NETWORK");
                }
            } catch (SocketTimeoutException e) {
                call.reject("连接超时", "ERR_TIMEOUT");
            } catch (Exception e) {
                call.reject("网络请求失败: " + e.getClass().getSimpleName(), "ERR_NETWORK");
            }
        }, "pocketcode-bridge-request").start();
    }

    private String readCapped(InputStream stream) throws Exception {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[64 * 1024];
        int read;
        int total = 0;
        while ((read = stream.read(chunk)) != -1) {
            total += read;
            if (total > MAX_RESPONSE_BYTES) {
                throw new Exception("response too large");
            }
            buffer.write(chunk, 0, read);
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    /** 指纹非空：仅信任链上匹配该指纹的证书；为空：诊断模式放行任意证书。 */
    private SSLSocketFactory sslFactoryFor(String expectedFingerprint,
                                           AtomicBoolean mismatchFlag) throws Exception {
        final String expected = normalizeFingerprint(expectedFingerprint);
        TrustManager trustManager = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType)
                    throws CertificateException {
                if (expected.isEmpty()) {
                    return; // 诊断模式：/v1/health 无凭据无敏感数据（ADR-0004）
                }
                if (chain == null || chain.length == 0) {
                    throw new CertificateException("empty certificate chain");
                }
                for (X509Certificate cert : chain) {
                    try {
                        if (sha256Hex(cert.getEncoded()).equals(expected)) {
                            return; // 指纹匹配 = 身份成立
                        }
                    } catch (Exception ignored) {
                        // 单张证书编码失败则检查链上下一张
                    }
                }
                mismatchFlag.set(true);
                throw new CertificateException("certificate fingerprint mismatch");
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };

        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{trustManager}, new SecureRandom());
        return context.getSocketFactory();
    }

    /** 身份由指纹承担（配对二维码人工/扫码核对），豁免主机名匹配。 */
    private HostnameVerifier trustingHostnameVerifier() {
        return (hostname, session) -> true;
    }

    private static String normalizeFingerprint(String fingerprint) {
        if (fingerprint == null) return "";
        return fingerprint.replace("sha256:", "").replace(":", "").trim().toLowerCase();
    }

    private static String sha256Hex(byte[] data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        StringBuilder builder = new StringBuilder();
        for (byte b : digest.digest(data)) {
            builder.append(String.format("%02x", b));
        }
        return builder.toString();
    }

    // ------------------------------------------------ 文件 KV 存储（草稿/缓存）
    /** 草稿与缓存的可靠持久化：应用私有文件目录，逐 key 一份 UTF-8 文本。
     *  WebView localStorage 在 Android 上可能被系统清理，不能承载草稿。 */
    private java.io.File dataDir() {
        java.io.File dir = new java.io.File(getContext().getFilesDir(), "pocketcode_data");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private synchronized DiskKeyValueStore dataStore() throws java.io.IOException {
        if (diskStore == null) diskStore = new DiskKeyValueStore(dataDir());
        return diskStore;
    }

    @PluginMethod
    public void dataSet(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        try {
            dataStore().set(key, value);
            call.resolve();
        } catch (Exception e) {
            call.reject("数据写入失败: " + e.getMessage(), "ERR_DATA");
        }
    }

    @PluginMethod
    public void writeShareArchive(PluginCall call) {
        String name = call.getString("name", "project.zip");
        String data = call.getString("base64", "");
        // 在解码前限制桥接输入，避免无界内存分配。
        if (data.length() > ((ShareArchiveStore.MAX_BYTES + 2) / 3) * 4) {
            call.reject("ZIP 超过分享大小上限", "ERR_SHARE_ARCHIVE");
            return;
        }
        new Thread(() -> {
            try {
                byte[] bytes = android.util.Base64.decode(data, android.util.Base64.NO_WRAP);
                java.io.File file = new ShareArchiveStore(getContext().getCacheDir()).write(name, bytes);
                JSObject result = new JSObject();
                result.put("uri", android.net.Uri.fromFile(file).toString());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("ZIP 临时文件写入失败：" + error.getMessage(), "ERR_SHARE_ARCHIVE");
            }
        }).start();
    }

    @PluginMethod
    public void dataGet(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("value", dataStore().get(call.getString("key", "")));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("数据读取失败: " + e.getMessage(), "ERR_DATA");
        }
    }

    @PluginMethod
    public void dataDelete(PluginCall call) {
        try {
            dataStore().remove(call.getString("key", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject("数据删除失败: " + e.getMessage(), "ERR_DATA");
        }
    }

    /** 按前缀枚举存储键（S4a2 草稿箱需要跨文件列出全部草稿）。 */
    @PluginMethod
    public void dataKeys(PluginCall call) {
        String prefix = call.getString("prefix", "");
        try {
            JSObject result = new JSObject();
            com.getcapacitor.JSArray keys = new com.getcapacitor.JSArray();
            for (String key : dataStore().keys(prefix)) keys.put(key);
            result.put("keys", keys);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("枚举存储键失败: " + e.getMessage(), "ERR_DATA");
        }
    }

    // ---------------------------------------------------------------- 系统设置
    /** 跳转本应用的系统设置页（相机权限被"永久拒绝"时的兜底入口）。 */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    android.net.Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("无法打开系统设置: " + e.getMessage(), "ERR_SETTINGS");
        }
    }

    // ---------------------------------------------------------------- 安全存储
    private SharedPreferences securePrefs() throws Exception {        if (securePrefs == null) {
            Context context = getContext();
            MasterKey masterKey = new MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build();
            securePrefs = EncryptedSharedPreferences.create(
                    context, "pocketcode_secure_prefs", masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        }
        return securePrefs;
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key", "");
        String value = call.getString("value", "");
        if (key.isEmpty()) {
            call.reject("key 不能为空", "ERR_KEY");
            return;
        }
        try {
            securePrefs().edit().putString(key, value).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("安全存储写入失败: " + e.getMessage(), "ERR_SECURE_STORAGE");
        }
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        try {
            String value = securePrefs().getString(call.getString("key", ""), null);
            JSObject result = new JSObject();
            result.put("value", value);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("安全存储读取失败: " + e.getMessage(), "ERR_SECURE_STORAGE");
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        try {
            securePrefs().edit().remove(call.getString("key", "")).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("安全存储删除失败: " + e.getMessage(), "ERR_SECURE_STORAGE");
        }
    }
}
