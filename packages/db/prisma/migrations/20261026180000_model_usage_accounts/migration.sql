CREATE TABLE "user_model_usage_accounts" (
  "credentialId" TEXT NOT NULL,
  "usageAccountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  CONSTRAINT "user_model_usage_accounts_pkey" PRIMARY KEY ("credentialId", "usageAccountId"),
  CONSTRAINT "user_model_usage_accounts_credentialId_userId_fkey"
    FOREIGN KEY ("credentialId", "userId") REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_model_usage_accounts_usageAccountId_userId_fkey"
    FOREIGN KEY ("usageAccountId", "userId") REFERENCES "user_model_credentials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_model_usage_accounts_not_self" CHECK ("credentialId" <> "usageAccountId")
);
CREATE INDEX "user_model_usage_accounts_usageAccountId_userId_idx" ON "user_model_usage_accounts"("usageAccountId", "userId");
ALTER TABLE "user_model_usage_accounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_model_usage_accounts_tenant ON "user_model_usage_accounts"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY user_model_usage_accounts_system ON "user_model_usage_accounts"
  USING (current_setting('app.rls_bypass', true) = 'on');
