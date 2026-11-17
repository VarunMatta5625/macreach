MacReach: first run
===================

1. Drag MacReach into the Applications folder, then eject this disk image.
2. Open MacReach from Applications.
3. macOS will say it "cannot be opened" because MacReach is not from the App Store and is not notarized by Apple (that costs a
   developer fee). It is safe to continue if you downloaded it from the MacReach GitHub page:
     - Open System Settings > Privacy & Security.
     - Scroll down to the message about MacReach and click "Open Anyway", then confirm with your Mac password or Touch ID.
     - Open MacReach again.
   Prefer Terminal? This does the same thing:   xattr -dr com.apple.quarantine /Applications/MacReach.app
4. A monitor icon appears in the menu bar and the Setup assistant opens. It walks you through everything: macOS permissions,
   your password, and Tailscale (the free service that lets your phone or tablet reach this Mac).
5. In Tailscale's admin page, turn OFF key expiry for this Mac. Otherwise Tailscale signs it out after 180 days and your link stops
   working until you sign in again. Setup shows the exact steps.

If the Mac's firewall is on, macOS may ask whether "tailscaled" can accept incoming connections: click Allow. (If you click Deny, Tailscale still works through its relay servers, only slower.)

Requires macOS 14 or newer on an Apple Silicon Mac (M1 or later; Intel Macs are not supported by this download). To remove MacReach: menu bar icon > Uninstall MacReach.
