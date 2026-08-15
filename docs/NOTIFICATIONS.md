# Self-hosted notifications

Atelier's notification privacy invariant is simple: notification payloads must
not be sent to a service outside infrastructure the operator controls. Nothing
is configured by default.

## Delivery paths today

Atelier has two independent paths:

- The cockpit's opt-in desktop notifications use the existing browser SSE
  connection and the browser `Notification` API. They work while the cockpit
  remains open, without adding a notification server.
- `defaults.notifyUrl` is an opt-in outbound HTTP POST seam. It covers terminal
  dispatches, settled reviews, and failed post-merge health checks. It is the
  cross-device path when pointed at a SELF-HOSTED receiver.

Outbound delivery is fire-and-forget. Atelier applies a five-second timeout,
ignores receiver errors so notification trouble cannot change dispatch state,
and does not persist a delivery receipt. Treat the dispatch record and SSE
event as the source of truth, not arrival of a notification.

Atelier sends a plain-text body with ntfy-compatible `Title` and `Tags` headers.
The fields are redacted and bounded where failure evidence is included, but
they are not anonymous: a payload can contain project and dispatch IDs, a
ticket ID, state and verification result, a review summary, the trailing
question of a `needs_input` dispatch, or post-merge failure evidence. Keep the
entire delivery route private.

A dispatch that ended by asking a question is titled `needs input` (tag
`question`) rather than `completed`, and its body carries the question plus the
"reply & resume to answer" action; a dispatch that produced no changes is titled
`completed with no changes` (tag `information_source`). Both are deliberately
distinguishable at a glance from a real success.

## Phase 1: self-hosted ntfy

ntfy is one compatible receiver because it accepts a message body plus
`Title` and `Tags` over HTTP POST. Run the server yourself; the public
`ntfy.sh` service is deliberately not a supported Atelier configuration.

For a minimal same-host smoke setup, bind the container only to loopback:

```sh
docker run -d --name atelier-ntfy --restart unless-stopped \
  -p 127.0.0.1:2586:80 \
  binwiederhier/ntfy serve
```

The official [ntfy installation guide](https://docs.ntfy.sh/install/) also
covers the standalone binary, persistent cache, configuration, and service
installation. Test the local topic before changing Atelier:

```sh
curl --fail --data "Atelier notification test" \
  http://127.0.0.1:2586/atelier-alerts
```

Then add the topic URL to the existing `defaults` object in
`~/.config/atelier/projects.json` and restart Atelier:

```json
{
  "version": 1,
  "defaults": {
    "notifyUrl": "http://127.0.0.1:2586/atelier-alerts"
  },
  "groups": [],
  "projects": []
}
```

Preserve the real `groups` and `projects` arrays; the example only shows where
the setting belongs. Configure each subscriber against that same self-hosted
server and topic.

For another device, expose ntfy through an authenticated reverse proxy or a
tailnet address and set `notifyUrl` to that private endpoint, for example
`https://ntfy.<your-tailnet>.ts.net/atelier-alerts`. Keep Atelier itself on
loopback. Use TLS when the hop is not loopback, restrict who can publish and
subscribe, and audit the subscriber's own delivery route: a self-hosted server
does not by itself prove that a browser or mobile client avoids vendor push
infrastructure.

For a strict no-third-party deployment, leave ntfy's `upstream-base-url`,
Firebase, Web Push, email, and call integrations unset. Subscriber choice is
part of the boundary too:

- The ntfy Android F-Droid build maintains a direct connection and contains no
  Firebase services. See ntfy's [mobile client documentation](https://docs.ntfy.sh/subscribe/phone/#instant-delivery).
- Background notifications in the ntfy web app use the browser vendor's push
  endpoint. Use its direct foreground connection only when vendor push is not
  acceptable.
- Instant delivery in the official iOS app requires an upstream service and
  APNS/Firebase. It is therefore not compatible with the strict boundary; the
  [ntfy iOS configuration notes](https://docs.ntfy.sh/config/#ios-instant-notifications)
  document that tradeoff.

Atelier does not send an authentication header. The registry must not contain
credentials, bearer tokens, or a secret topic embedded in the URL. If the
receiver requires credentials, terminate the Atelier request at a local,
operator-controlled proxy that adds them, or keep publishing limited by
loopback/tailnet network policy.

To turn outbound delivery off, remove `notifyUrl` and restart Atelier.

## Phase 2 decision: local companion, not Web Push

The post-v3 Atelier-native background path will be an optional bundled local
notifier. It can consume Atelier's existing event stream on loopback and invoke
the host notification facility without a cloud account or third-party atelier.
It must remain optional so the core server keeps its zero-runtime-dependency
contract. The existing browser SSE notification path remains the zero-install
foreground fallback, and `notifyUrl` remains the stable integration seam for
self-hosted cross-device receivers.

The alternatives have different privacy and availability properties:

| Candidate | Stays in controlled infrastructure | Works after the cockpit closes | Decision |
| --- | --- | --- | --- |
| Browser Web Push with local VAPID keys | No. The subscription endpoint belongs to a browser push service, although the payload is encrypted. | Yes, subject to browser/OS policy. | Not a default or privacy-preserving path. |
| Installable PWA plus persistent SSE | Yes while the browser maintains the direct connection. | Not reliably; mobile and desktop browsers may suspend or terminate it. | Keep as the foreground fallback. |
| Optional bundled local notifier | Yes; it talks to loopback and the host OS. | Yes while its local service is running. | Chosen Atelier-native background direction. |

The Web Push distinction is structural: the Push API subscription exposes an
endpoint at a push server, as documented by MDN's
[`PushSubscription.endpoint`](https://developer.mozilla.org/en-US/docs/Web/API/PushSubscription/endpoint).
Generating VAPID keys locally authenticates and encrypts the sender; it does
not make that endpoint self-hosted.

The future companion must preserve these boundaries:

1. Atelier's HTTP server still binds only to `127.0.0.1`.
2. No cloud registration, analytics, or third-party push endpoint is required.
3. It consumes the same normalized event meaning as the UI and does not gain a
   privileged control surface.
4. Notification failure never changes dispatch, review, merge, or verification
   state.
5. The generic outbound POST seam remains available for operator-owned bridges
   and is never silently redirected to a hosted service.
