---
# churn-234f
title: Repair corrupted build artifacts / toolchain after SSD corruption
status: scrapped
type: bug
priority: normal
created_at: 2026-11-10T20:24:56Z
updated_at: 2026-11-10T20:25:20Z
---

cargo build fails: collect2: fatal error: ld terminated with signal 7 [Bus error]. Root cause: corrupted files on disk (EIO on read), not toolchain. 8 corrupt files under target/.

## Todo
- [ ] Create bean and record diagnosis
- [ ] Scan rustup toolchain + cargo registry for EIO
- [ ] Remove corrupted build artifacts and relink
- [ ] Verify cargo build/run works
- [ ] Report remaining system-level damage (binutils dup pkg, btrfs corruption count, scrub/reinstall needing root)

## Reasons for Scrapping

User asked not to file a bean for this; fixing the environment issue directly instead.
