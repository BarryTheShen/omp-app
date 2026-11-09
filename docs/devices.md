# Other devices

This page covers opening the app from your phone, tablet or another computer: how to serve it on your tailnet, how a device pairs, how to manage and remove devices, how to put it on an iPhone or iPad Home Screen, how the desktop window opens another computer's server, and how to share a port. Each section that changes something ends with how to undo it.

## Why does the server listen on this computer only?

omp runs commands and changes files as your account. Whoever can use the app can do what your account can do on the computer it runs on, so the app is built to be reachable by you alone. The server listens on 127.0.0.1 (port 4317 by default) and on nothing else. Another computer on your network cannot connect to it, and it is never offered to the internet.

Two things let you in:

- **On this computer,** the link `omp-app` prints, with its secret after `#token=`. It counts only for a page of this computer: a request that came through a proxy such as `tailscale serve` cannot use it.
- **From another device,** pairing. The device opens the app's address through `tailscale serve`, which gives it HTTPS on your tailnet, and pairs once.

[SECURITY.md](../SECURITY.md) lists what the app guards and what it assumes.

## How do I serve the app on my tailnet?

You need [Tailscale](https://tailscale.com) on this computer and on the device. Tell the app its Tailscale address, then have Tailscale serve it. The address is this computer's Tailscale name, `https://<computer>.<tailnet>.ts.net`:

```bash
export OMP_APP_REMOTE_ORIGIN=https://<computer>.<tailnet>.ts.net   # this computer's Tailscale name; then start omp-app
tailscale serve --bg localhost:4317                                # HTTPS on the tailnet, passed to the app's port
```

`omp-app` then prints the address to open on another device of your tailnet:

```text
From another device on your tailnet, open https://<computer>.<tailnet>.ts.net and pair it: allow it on a device that is already paired, or enter the one-time code omp-app pair prints here.

This computer must serve it: tailscale serve --bg localhost:4317
```

The port in that last line is the one the app really uses. If the app took another port (because 4317 was busy), give that port to `tailscale serve`.

The app accepts only an `https://` address that ends in `.ts.net`, with no port, path, query or fragment, and refuses to start with anything else, naming the problem. The server still listens on 127.0.0.1 only. `tailscale serve` passes the browser's Host on, so the app allows that host and that origin besides its own.

**When the user service runs the app,** set the variable for the service instead, and restart it so the server reads it:

```bash
systemctl --user edit omp-app
```

```ini
[Service]
Environment=OMP_APP_REMOTE_ORIGIN=https://<computer>.<tailnet>.ts.net
```

```bash
systemctl --user restart omp-app
```

A variable exported in your own shell does not reach the service, and `omp-app` run in a shell only attaches to a server that is already running, so it changes nothing there. [Configuration](configuration.md#how-do-i-set-variables-for-the-user-service) has the details, including quoting.

To check it, open the address on another device of your tailnet. A device that is not paired yet shows "Pair this device".

**Undo:** stop serving with `tailscale serve --https=443 off`. Then remove the variable (delete the `Environment` line with `systemctl --user edit omp-app`, or run `systemctl --user revert omp-app`, or unset it in your shell) and restart the app. Devices you already paired stay in the list until you remove them (see [How do I manage the paired devices?](#how-do-i-manage-the-paired-devices)), but nothing can reach the app from outside this computer.

## How do I pair a device?

Each phone, computer or browser that opens the app's address is paired once, and stays paired until you remove it. The browser you open with the launch link on this computer needs no pairing; it is how you allow the first other device.

Open the address on the new device. It shows **Pair this device** and a field, "This device's name", which you can change. Pair it one of two ways.

**Ask to pair.** On the new device, press **Ask to pair**. It shows 6 digits and "Waiting…". Every paired device shows a prompt, "A device wants to pair", with the new device's name and kind and the same 6 digits. Check that the digits match, then press **Allow**. **Deny** turns the request down, and the new device says so and offers **Ask again**. The prompt can be put away with Esc, and the request then waits in Settings → App → Devices, where it has **Allow** and **Deny** too. In the desktop window, a notification also says a device asks. A request ends after 5 minutes, and up to five can wait at once.

**A one-time code.** On a paired device, open **Settings → App → Devices** and press **Pair a new device**, or run `omp-app pair` on this computer. Either shows a code of 8 letters and digits, and its QR code. On the new device, scan the QR code with the camera, which opens the app and pairs at once. Or open the address, press **Enter a code instead**, type the code in "One-time code", and press **Pair**.

- A code works once, for 10 minutes.
- Five wrong entries end it. The new device says "That code is not right" with the tries left, and then "That code no longer works".
- **New code** (or running `omp-app pair` again) makes a new code, and the old one stops working.
- The address shown with the code is the one `OMP_APP_REMOTE_ORIGIN` names. Without that variable it is this computer's own address, `http://127.0.0.1:<port>`, which no other device can open.

A paired device keeps its key in a cookie that only the app's own pages send. The app keeps only a hash of each key. A panel inside another app (an extension's, an editor's) gets no cookie of the app, so its host keeps the key instead and hands it back at each start; see [Integrations](integrations.md#how-does-a-panel-sign-in).

**Undo:** remove the device (see below). It then pairs again to come back.

## How do I manage the paired devices?

**Settings → App → Devices** lists the paired devices with their kind (Home Screen app, desktop window or browser), when each was paired, and when it last connected ("Last seen" and the time, or "Not connected yet"). The device you are using is marked "This device".

- **Rename** names a device (up to 60 characters); **Save** keeps the name.
- **Remove** asks "Remove <name>?" and, once you confirm with **Remove**, closes the device's open windows and ends its sessions, including on every shared port. It pairs again to come back. Removing the device you are using closes this page the same way.
- **Pair a new device** makes a one-time code, as above.

On this computer, `omp-app devices` lists the same devices, with the start of each id, and `omp-app devices remove <device>` removes one, named by its id, the start of it, or its name. Both need the app to be running.

**Undo:** a removed device is paired again the way it was the first time.

## How do I put the app on an iPhone or iPad Home Screen?

On the device, open the app's address in Safari, tap **Share**, then **Add to Home Screen**. The icon is named "omp". It opens as an app of its own, full screen, clear of the notch and the home bar, with the message box above the keyboard. The first time it opens, pair it: allow it on a device that is already paired, or enter a one-time code. The Devices list shows it as a Home Screen app. With an iPad's keyboard, every Ctrl key works with ⌘ too.

Below 640 pixels wide the app uses the phone layout, and a touch screen wider than that gets full-size controls; see [Using the app](using.md#the-phone-and-tablet-layout).

**Undo:** remove the icon from the Home Screen, and remove the device in Settings → App → Devices.

## How do I open another computer's server in the desktop window?

The window normally opens the app on this computer's own server. It can open the server on another computer of your tailnet instead, the one served as above:

```bash
omp-app-desktop --remote 'https://<computer>.<tailnet>.ts.net'   # keeps the address and opens that server
omp-app-desktop --local                                          # back to this computer's own server
```

You can do the same inside the window. In **Settings → App → Server**, type the address in "Connect to another server" and press **Connect**; the list above it shows "This computer" and each server the window opened before, with an **Open** button. The palette (Ctrl+K) has "Connect to another server…", "Use this computer's server" and "Open the server on <computer>".

The window keeps the address in `~/.config/omp-app/desktop-server` (under `$XDG_CONFIG_HOME` when that is an absolute path), a file only your account can read, and opens that server at every launch, starting nothing on this computer. The first time, it pairs with that server like any other device. Only an `https://` address is accepted.

If the other computer does not answer, the window shows "omp app could not reach" with its name: it may be off, not on the tailnet, or not serving the app with `tailscale serve`. If it answers but the app does not open there, the window says "omp app did not open on" that computer, with the reason.

**Undo:** run `omp-app-desktop --local`, or choose "Use this computer's server". Remove the window from the other computer's Devices list if you no longer want it paired.

## How do I share a port with my devices?

The side panel's **Ports** panel lists the services running on this computer, so that you can open one on a paired device: a web page a chat started, for example. **Share** a service, then press **Open**: it opens in the browser on the device you are using, at this computer's Tailscale address on a port of its own. **Copy link** copies a link that works once, within a minute.

- Only devices paired with the app get in. A one-time ticket from the app signs a device in to that one share.
- A service that a chat starts is shared by itself once it has listened for 5 seconds, and the chat shows a line with **Open**. The panel lists such services first, under "Started by your chats, or shared"; every other port is folded under "Other services on this machine".
- An HTML file written in a chat's folder can be shared as a page, from the write's card in the chat or from the Files panel: **Share as a page**, then **Open in browser**. Shared pages are listed under "Pages".
- A share ends when its service stops (the panel then says "This share ended: the service stopped."), when you press **Stop sharing**, or after 12 hours unused. The app, remote login, sync and network tools, databases, browsers and omp's browser relay are never shared: the panel says "Never shared: it is on the never-share list."
- With no Tailscale address on this computer the panel says "This machine has no Tailscale address, so nothing can be shared." To share on another address of this computer, set `OMP_APP_SHARE_ADDRESS` (see [Configuration](configuration.md#environment-variables)).

**Undo:** press **Stop sharing**, or stop the service itself.
