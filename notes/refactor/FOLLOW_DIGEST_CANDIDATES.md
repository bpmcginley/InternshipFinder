# Bounded Follow digest expiry candidates

Engineering owns the dormant digest expiry candidate module, its focused tests, migration 0033, the corresponding schema index mirror and the migration parity assertion. The existing scheduler, Worker entry point, delivery owner and Product tracker stay outside this package.

The candidate path will sample D1 time once, preserve rowid order across the complete bounded set of due attempts, and revalidate that set and the selected job in the atomic mutation batch. A third due attempt will return unavailable without mutating any job. An old job will receive its existing state transition before deletion when both apply.

No scheduler or production configuration is selected. Local SQLite and Workerd/D1 qualification are pending.
