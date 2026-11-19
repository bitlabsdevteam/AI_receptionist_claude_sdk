# Telnyx research

Background for the phone Channel (issue #17). Everything here was fetched from Telnyx's public docs and pricing pages on 2026-11-16. Each claim in the notes is tagged as quoted, inferred or unverified, and each file ends with the gaps and contradictions found in the docs.

| File | What it covers |
|---|---|
| `relay.md` | Conversation Relay: Telnyx turns the Caller's speech into text and our text into speech over one WebSocket. The frames, the start request, interruption, ending, limits, pricing. |
| `call-control.md` | The Voice API (Call Control): the events of an inbound call, webhook signatures and delivery, commands, `speak`, media streaming, transfers, pricing. |
| `texml.md` | TeXML: the request and response loop with `<Gather>` and `<Say>`, its webhooks and their gaps. |
| `proposal.md` | The proposal the spec is based on. The spec wins where they differ. |

`spike-findings.md` will be added by issue #23, with what a real call confirmed or contradicted.
