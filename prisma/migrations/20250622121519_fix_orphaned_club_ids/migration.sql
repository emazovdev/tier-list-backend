-- This is an empty migration.
-- Исправляем орфанные club_id в игровых сессиях, связанных с удаленными клубами
UPDATE game_sessions 
SET club_id = NULL 
WHERE club_id IS NOT NULL 
  AND club_id NOT IN (SELECT id FROM clubs);