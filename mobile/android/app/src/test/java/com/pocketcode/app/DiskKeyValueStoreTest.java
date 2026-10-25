package com.pocketcode.app;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import static org.junit.Assert.*;

public class DiskKeyValueStoreTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    @Test public void longAndSpecialKeysSurviveReopenAndEnumeration() throws Exception {
        File root = temporary.newFolder();
        DiskKeyValueStore store = new DiskKeyValueStore(root);
        String[] keys = {
            "pc.draft.uuid.docs%2Fnotes(1)!'*-.py",
            "pc.draft.uuid." + "%E4%B8%AD".repeat(80)
        };
        for (String key : keys) store.set(key, "草稿内容\n");
        store = new DiskKeyValueStore(root);
        assertEquals(2, store.keys("pc.draft.").size());
        for (String key : keys) {
            assertEquals("草稿内容\n", store.get(key));
            store.set(key, "updated");
            assertEquals("updated", store.get(key));
            store.remove(key);
            assertNull(store.get(key));
        }
        assertTrue(store.keys("pc.draft.").isEmpty());
    }

    @Test public void legacyDraftRemainsReadableAndMigratesOnUpdate() throws Exception {
        File root = temporary.newFolder();
        String key = "pc.draft.uuid.file.py";
        File legacy = new File(root, key);
        Files.write(legacy.toPath(), "old idea".getBytes(StandardCharsets.UTF_8));
        DiskKeyValueStore store = new DiskKeyValueStore(root);
        assertEquals("old idea", store.get(key));
        assertEquals(1, store.keys("pc.draft.").size());
        store.set(key, "new idea");
        assertFalse(legacy.exists());
        store = new DiskKeyValueStore(root);
        assertEquals("new idea", store.get(key));
        assertEquals(1, store.keys("pc.draft.").size());
    }
}
