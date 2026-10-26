CREATE TABLE "subscription_quota_pools" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "poolKey" TEXT NOT NULL,
  "state" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "poolKey")
);
ALTER TABLE "subscription_quota_pools" ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_quota_pools_tenant ON "subscription_quota_pools"
  USING ("userId" = NULLIF(current_setting('app.user_id', true), ''));
CREATE POLICY subscription_quota_pools_system ON "subscription_quota_pools"
  USING (current_setting('app.rls_bypass', true) = 'on');
