# Reference hash repair native VM fix

The signed r846 package passed local preparation and upload. Activation stopped
before pausing services or changing the running r844 release. The server runs
the signed incident reader inside a Node VM context; its exact migration-name
comparison rejected an Array returned by the host `fs.readdirSync` because the
Array prototypes belong to different contexts. A pinned read-only reproduction
using the native VM wrapper reported identical names with different prototypes.
The direct reader accepted the same incident while retaining failed worker
health. No database or data-contract difference was observed.

The reader now copies the directory result through its own `Array.from` before
sorting and comparing all names. The exact membership assertion stays intact.
Three serialized VM fixtures cover identical names, an additional migration,
and missing incident journal evidence. The latter two still reject preparation.

This change does not establish worker recovery. The archive streaming repair
preserves native JSON byte order and hashes. Natural full synchronization,
source/dist/PG identity, public TLS and frozen recommendation continuity still
require new actual receipts after a successful signed code release. Existing
recommendation records, parameters and schemas are not changed by this fix.
