-- Additive private state. No public Artifact linkage and no plaintext fallback.
CREATE TABLE "native_conversation_states" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bindingHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "spaceId" TEXT NOT NULL REFERENCES "spaces"("id") ON DELETE CASCADE,
  "threadId" TEXT NOT NULL REFERENCES "threads"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL REFERENCES "bots"("id") ON DELETE CASCADE,
  "credentialId" TEXT NOT NULL REFERENCES "user_model_credentials"("id") ON DELETE CASCADE,
  "accountGeneration" TEXT NOT NULL REFERENCES "secrets"("id") ON DELETE CASCADE,
  "ciphertext" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "claimHostId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "native_conversation_states_ciphertext_check" CHECK (
    "ciphertext" IS NULL OR ("ciphertext" LIKE 'rkz1:%' AND octet_length("ciphertext") <= 8388608)
  )
);
CREATE INDEX "native_conversation_states_threadId_idx" ON "native_conversation_states"("threadId");
CREATE INDEX "native_conversation_states_credentialId_idx" ON "native_conversation_states"("credentialId");
CREATE INDEX "native_conversation_states_accountGeneration_idx" ON "native_conversation_states"("accountGeneration");
ALTER TABLE "native_conversation_states" ENABLE ROW LEVEL SECURITY;
CREATE POLICY native_conversation_states_tenant ON "native_conversation_states"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY native_conversation_states_system ON "native_conversation_states"
  USING (current_setting('app.rls_bypass', true) = 'on');
