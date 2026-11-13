INSERT INTO accounts (user_hash, first)
SELECT e.user_hash, MIN(e.t) FROM (
  SELECT user_hash, month || '-01T00:00:00.000Z' AS t, date(month || '-01', '+1 month') AS upto FROM usage
  UNION ALL SELECT user_hash, updated, updated FROM demand
  UNION ALL SELECT user_hash, updated, updated FROM plans
  UNION ALL SELECT user_hash, created, created FROM invite_codes
) AS e LEFT JOIN accounts AS a ON a.user_hash = e.user_hash
WHERE a.user_hash IS NULL OR e.upto <= a.first
GROUP BY e.user_hash
ON CONFLICT(user_hash) DO UPDATE SET first = excluded.first WHERE excluded.first < accounts.first;

INSERT INTO inviters (user_hash, rewarded)
SELECT referrer, COUNT(*) FROM referrals WHERE referrer != '' AND rewarded = 1 GROUP BY referrer
ON CONFLICT(user_hash) DO UPDATE SET rewarded = excluded.rewarded WHERE excluded.rewarded > inviters.rewarded;
