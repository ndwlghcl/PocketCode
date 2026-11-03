package com.pocketcode.app;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** 仅向应用私有缓存写 ZIP；不接受外部路径，不触碰草稿或下载目录。 */
public final class ShareArchiveStore {
    public static final int MAX_BYTES = 16 * 1024 * 1024;
    private static final long RETENTION_MS = 24L * 60 * 60 * 1000;
    private final File root;

    public ShareArchiveStore(File cacheDir) throws IOException {
        root = new File(cacheDir, "pocketcode-share").getCanonicalFile();
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建分享临时目录");
    }

    public File write(String name, byte[] bytes) throws IOException {
        if (bytes == null || bytes.length < 4 || bytes.length > MAX_BYTES
                || bytes[0] != 'P' || bytes[1] != 'K' || bytes[2] != 3 || bytes[3] != 4) {
            throw new IOException("ZIP 数据无效或超过 16 MiB 上限");
        }
        cleanExpired(System.currentTimeMillis());
        String safe = name == null ? "project" : name.replaceAll("[^\\p{L}\\p{N}._ -]", "_");
        if (safe.toLowerCase(java.util.Locale.ROOT).endsWith(".zip")) safe = safe.substring(0, safe.length() - 4);
        if (safe.length() > 80) safe = safe.substring(0, 80);
        File file = File.createTempFile("pocketcode-" + safe + "-", ".zip", root);
        try {
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes); out.flush(); out.getFD().sync();
            }
            return file;
        } catch (IOException error) {
            file.delete();
            throw error;
        }
    }

    public void cleanExpired(long now) throws IOException {
        File[] files = root.listFiles();
        if (files == null) throw new IOException("无法读取分享临时目录");
        for (File file : files) {
            if (file.isFile() && file.getName().startsWith("pocketcode-") && file.getName().endsWith(".zip")
                    && file.getCanonicalFile().getParentFile().equals(root)
                    && now - file.lastModified() > RETENTION_MS) file.delete();
        }
    }
}
