# P2 Release Closeout Checklist

- [ ] PR head verify green
- [ ] PR head integration/offline chaos/financial reconciliation/DB integrity green
- [ ] PR head production-scale certification green
- [ ] PR head P1 WebKit mobile/PWA certification green
- [ ] PR head P2 WebKit UI/accessibility certification green
- [ ] PR head dependency/secret audit green
- [ ] PR head CodeQL high/critical gate green
- [ ] P2 merged to main
- [ ] Exact main SHA deployed live on Render
- [ ] Production deploy certification green on exact main SHA
- [ ] Fresh encrypted production backup generated for final release SHA
- [ ] Backup artifact stored off-site with 90-day retention and production acknowledgement
- [ ] Recovery integration suite remains green and P0 disaster-recovery restore proof remains valid
- [ ] No known accounting correctness blocker
- [ ] No important open P2 PR/branch left carrying unmerged fixes
- [ ] Stable release tag points at the fully certified final main SHA

No production migration or manual TablePlus SQL is required for P2.
