-- Migration 044: Cleanup unapproved AI-synthesized answers from gh_candidate_qa_bank
-- Enforces policy: answers enter the QA bank ONLY when an application is approved/queued by an operator.
-- Approved answers saved via persistApprovedAiAnswersToQaBank use source = 'manual' (confidence = 1.0).
-- Any row with source = 'ai' represents an unapproved synthesis that bypassed operator review.

DELETE FROM gh_candidate_qa_bank
WHERE source = 'ai';
