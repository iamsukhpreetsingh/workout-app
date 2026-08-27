-- 037: corrects 036's import of legacy backup photos. 036 guessed the
-- stored filename from local_entity_id; the ACTUAL files are uuid-named
-- and their real keys sit in backup_progress_photos.storage_key (written
-- by the old upload route). Re-imports with correct keys — ON CONFLICT
-- DO UPDATE overwrites 036's bad keys if 036 already ran; if it hasn't,
-- 036 runs first and this immediately fixes it. Either path converges.
-- (Old system allowed accidental multiple rows per date — first wins.)
INSERT INTO progress_photos (user_id, photo_date, visibility, storage_provider, storage_key)
SELECT b.user_id, b.date::date, 'PERSONAL', 'local', b.storage_key
FROM backup_progress_photos b
ON CONFLICT (user_id, photo_date) DO UPDATE SET storage_key = EXCLUDED.storage_key;