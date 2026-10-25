package com.pocketcode.app;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.TreeSet;

/** 固定长度文件名 + 自描述记录；原始 key 保存在记录中，枚举不依赖另一个索引。
 * 旧版以 key 命名的 UTF-8 文件仍可读取，成功更新后才移除旧文件。
 */
public final class DiskKeyValueStore {
    private static final int MAGIC = 0x50434B32; // PCK2
    private final File root;

    public DiskKeyValueStore(File root) throws IOException {
        this.root = root;
        if (!root.isDirectory() && !root.mkdirs()) throw new IOException("无法创建数据目录");
    }

    private File fileForKey(String key) throws IOException {
        if (key == null || key.isEmpty() || key.length() > 8192) {
            throw new IOException("非法的存储键");
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder name = new StringBuilder("kv2-");
            for (byte value : digest) name.append(String.format("%02x", value));
            return new File(root, name.toString());
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    private File legacyFile(String key) {
        // 只接受旧版本本来能写入的文件名，避免把 key 当成任意文件路径。
        if (key == null || key.length() > 200 || !key.matches("[A-Za-z0-9._%~-]+")
                || key.equals(".") || key.equals("..")) return null;
        return new File(root, key);
    }

    public synchronized String get(String key) throws IOException {
        File file = fileForKey(key);
        if (!file.exists()) {
            File legacy = legacyFile(key);
            return legacy != null && legacy.isFile()
                    ? new String(Files.readAllBytes(legacy.toPath()), StandardCharsets.UTF_8) : null;
        }
        try (DataInputStream in = new DataInputStream(new FileInputStream(file))) {
            if (in.readInt() != MAGIC || !in.readUTF().equals(key)) throw new IOException("数据键不匹配");
            byte[] value = new byte[in.available()];
            in.readFully(value);
            return new String(value, StandardCharsets.UTF_8);
        }
    }

    public synchronized void set(String key, String value) throws IOException {
        File file = fileForKey(key);
        File tmp = File.createTempFile("pending-", ".tmp", root);
        try {
            try (FileOutputStream bytes = new FileOutputStream(tmp);
                 DataOutputStream out = new DataOutputStream(bytes)) {
                out.writeInt(MAGIC);
                out.writeUTF(key);
                out.write(value.getBytes(StandardCharsets.UTF_8));
                out.flush();
                bytes.getFD().sync();
            }
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE,
                    StandardCopyOption.REPLACE_EXISTING);
            File legacy = legacyFile(key);
            if (legacy != null) Files.deleteIfExists(legacy.toPath());
        } finally {
            Files.deleteIfExists(tmp.toPath());
        }
    }

    public synchronized void remove(String key) throws IOException {
        Files.deleteIfExists(fileForKey(key).toPath());
        File legacy = legacyFile(key);
        if (legacy != null) Files.deleteIfExists(legacy.toPath());
    }

    public synchronized ArrayList<String> keys(String prefix) throws IOException {
        TreeSet<String> result = new TreeSet<>();
        File[] entries = root.listFiles();
        if (entries == null) throw new IOException("无法读取数据目录");
        for (File entry : entries) {
            if (!entry.isFile() || entry.getName().startsWith("pending-")) continue;
            String key = entry.getName();
            if (key.matches("kv2-[0-9a-f]{64}")) {
                try (DataInputStream in = new DataInputStream(new FileInputStream(entry))) {
                    if (in.readInt() != MAGIC) continue;
                    key = in.readUTF();
                    if (!fileForKey(key).getName().equals(entry.getName())) continue;
                }
            }
            if (key.startsWith(prefix)) result.add(key);
        }
        return new ArrayList<>(result);
    }
}
