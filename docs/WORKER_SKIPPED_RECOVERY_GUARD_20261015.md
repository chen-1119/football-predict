# A skipped loop is not official recovery

The actual read only r876 observation at 13:50 UTC showed an `ok:true` skipped
loop, ending 13:46:55 because the background lane held the sync lock. Its latest
official event had failed at 13:41:27. The last genuine complete official cycle
ended earlier, at 13:25:07. The old preparation policy incorrectly returned true.
The minimal fixture is bound to the raw observation SHA
6974988c30f0390fccb19a5de1e4e2a4ce5212d0a1bc57358d6adbe9fe5bf56d.

Reject skipped loops as preparation evidence, including a later running phase
or fast-only success. Also check the latest failed official event independently
of lastCycle. Only a genuine non-skipped, non-degraded complete cycle with its
official publication after that failure and bounded by this incarnation's clocks
can clear that historical failed event. All original checks and final gates stay.

This correction performs no writes, worker operation or new health observation.
Candidate 879 was prepared offline but not uploaded or activated. It is retained
as an unused older source artifact; a changed source needs a new HEAD, full CI,
unique normal package and actual natural recovery before deployment. Do not use
the old apparent true result or restart a worker to manufacture recovery.
