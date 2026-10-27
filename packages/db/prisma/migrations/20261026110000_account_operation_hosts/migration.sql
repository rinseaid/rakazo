-- Additive, separate from bot computers. No owner cascade: unresolved hosts need cleanup.
CREATE TABLE "account_operation_hosts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "cleanupRequestedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "account_operation_hosts_ttl_check" CHECK (
    "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + INTERVAL '15 minutes'
  )
);
CREATE INDEX "account_operation_hosts_userId_idx" ON "account_operation_hosts"("userId");
CREATE INDEX "account_operation_hosts_expiresAt_idx" ON "account_operation_hosts"("expiresAt");
CREATE INDEX "account_operation_hosts_cleanupRequestedAt_idx" ON "account_operation_hosts"("cleanupRequestedAt");
ALTER TABLE "account_operation_hosts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_operation_hosts_tenant ON "account_operation_hosts"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND "userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY account_operation_hosts_system ON "account_operation_hosts"
  USING (current_setting('app.rls_bypass', true) = 'on');
