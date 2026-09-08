# Real Device Mobile Certification

This certification is required before an exact `main` SHA can become a stable release.

## Devices

Test the same exact deployed SHA on:

- one physical iPhone using Safari
- one physical Android phone using Chrome

Record the exact device model and OS version in the GitHub workflow inputs.

## Required scenarios

Every scenario must pass on both devices unless the behavior is platform-specific.

1. Login and logout.
2. Create a normal financial entry and confirm the balance updates.
3. Transfer money and confirm both sides update correctly.
4. Correct an entry and confirm the original is no longer editable while audit history remains intact.
5. Void an entry and confirm the visible entry is removed from active views and all accounting effects reverse.
6. Go offline, create supported queued work, reconnect, and confirm exactly-once sync with no duplicate balance effect.
7. Upload a receipt, interrupt connectivity, reconnect, and confirm upload recovery.
8. Make a transaction from another session/device and confirm background realtime refresh without a browser reload.
9. Pull down from the top and confirm the app refreshes in place. Confirm a downward gesture while already scrolled behaves as normal scrolling.
10. Rotate portrait to landscape and back while forms/drawers are open.
11. Open and close the software keyboard in prompt/forms and confirm controls remain reachable.
12. Inspect Today, Statement, History, More, dialogs, drawers, and bottom navigation for clipping, horizontal overflow, or unreachable controls.

## Evidence

Capture screenshots or a short video showing the tested SHA and the critical flows. Store the evidence at an HTTPS URL accessible to the repository owner.

## GitHub signoff

Run **Actions → Real Device Mobile Certification → Run workflow** from the exact `main` revision that was tested.

Supply:

- exact `target_sha`
- tester name
- iPhone model and iOS version
- Android model and Android version
- HTTPS evidence URL
- every scenario checkbox as `true`

The workflow fails if the supplied SHA does not equal the workflow revision, if any scenario is not confirmed, or if evidence metadata is incomplete. A successful run retains `real-device-mobile-certification-<sha>` as an artifact for 90 days.

The stable-release workflow requires both the successful exact-SHA workflow run and that retained artifact.
