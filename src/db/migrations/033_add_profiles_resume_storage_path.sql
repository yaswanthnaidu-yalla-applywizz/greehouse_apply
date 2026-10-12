-- Migration 033: Add resume_storage_path column to profiles
-- Fixes missing column warning in profile listing batch queries

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_storage_path TEXT;
