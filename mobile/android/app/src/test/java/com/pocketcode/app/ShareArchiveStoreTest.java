package com.pocketcode.app;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.*;
import static org.junit.Assert.*;

public class ShareArchiveStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    private byte[] zip() throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(bytes)) {
            out.putNextEntry(new ZipEntry("源码/a.py"));
            out.write("print('小岚')\n".getBytes(StandardCharsets.UTF_8));
            out.closeEntry();
        }
        return bytes.toByteArray();
    }

    @Test public void writesReadableZipInsideCacheAndKeepsConcurrentArchives() throws Exception {
        File cache = temporary.newFolder();
        ShareArchiveStore store = new ShareArchiveStore(cache);
        File first = store.write("../../学习.zip", zip());
        File second = store.write("../../学习.zip", zip());
        assertEquals(new File(cache, "pocketcode-share").getCanonicalFile(), first.getCanonicalFile().getParentFile());
        assertNotEquals(first, second);
        assertTrue(first.isFile());
        try (ZipInputStream in = new ZipInputStream(new FileInputStream(first))) {
            assertEquals("源码/a.py", in.getNextEntry().getName());
            assertEquals("print('小岚')\n", new String(in.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @Test public void cleansOnlyExpiredArchivesAndRejectsInvalidInput() throws Exception {
        File cache = temporary.newFolder();
        ShareArchiveStore store = new ShareArchiveStore(cache);
        File old = store.write("old.zip", zip());
        assertTrue(old.setLastModified(System.currentTimeMillis() - 25L * 60 * 60 * 1000));
        File unrelated = new File(old.getParentFile(), "other.txt");
        Files.write(unrelated.toPath(), "KEEP".getBytes(StandardCharsets.UTF_8));
        File recent = store.write("new.zip", zip());
        assertFalse(old.exists()); assertTrue(recent.isFile()); assertTrue(unrelated.isFile());
        try { store.write("bad.zip", new byte[] {1, 2, 3, 4}); fail("invalid ZIP accepted"); }
        catch (IOException expected) { assertTrue(expected.getMessage().contains("ZIP")); }
    }
}
