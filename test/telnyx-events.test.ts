import { describe, expect, it } from "vitest";
import { parseWebhookEvent } from "../src/telnyx/events.js";

/**
 * The payloads below are the examples in Telnyx's docs (the Voice API webhooks guide and the webhook event catalogue,
 * `developers.telnyx.com/data/webhook-events.json`), with the phone numbers replaced by ones from the 555 range. None
 * of them was captured from a real call.
 */

const CALL_CONTROL_ID = "v3:MdI91X4lWFEs7IgbBEOT9M4AigoY08M0WWZFISt1Yw2axZ_IiE4pqg";
const CALL_SESSION_ID = "428c31b6-abf3-3bc1-b7f4-5013ef9657c1";
const CALLER = "+12025550133";
const OUR_NUMBER = "+12025550131";

const callInitiated = {
  data: {
    record_type: "event",
    event_type: "call.initiated",
    id: "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
    occurred_at: "2018-02-02T22:25:27.521992Z",
    payload: {
      call_control_id: CALL_CONTROL_ID,
      connection_id: "7267xxxxxxxxxxxxxx",
      call_leg_id: "d14dbcee-880b-11eb-8204-02420a0f7568",
      call_session_id: CALL_SESSION_ID,
      client_state: "aGF2ZSBhIG5pY2UgZGF5ID1d",
      from: CALLER,
      to: OUR_NUMBER,
      direction: "incoming",
      state: "parked",
    },
  },
  meta: { attempt: 1, delivered_to: "https://example.com/webhooks" },
};

const callAnswered = {
  data: {
    record_type: "event",
    event_type: "call.answered",
    id: "1ddd7b54-4df3-4bca-a65a-3da1ecc777f1",
    occurred_at: "2018-02-02T22:25:28.521992Z",
    payload: {
      call_control_id: CALL_CONTROL_ID,
      connection_id: "7267xxxxxxxxxxxxxx",
      call_leg_id: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
      call_session_id: CALL_SESSION_ID,
      client_state: "aGF2ZSBhIG5pY2UgZGF5ID1d",
      from: CALLER,
      to: OUR_NUMBER,
      start_time: "2018-02-02T22:25:27.521992Z",
      state: "answered",
    },
  },
};

const callHangup = {
  data: {
    record_type: "event",
    event_type: "call.hangup",
    id: "2eee7b54-4df3-4bca-a65a-3da1ecc777f2",
    occurred_at: "2018-02-02T22:30:27.521992Z",
    payload: {
      call_control_id: CALL_CONTROL_ID,
      connection_id: "7267xxxxxxxxxxxxxx",
      call_leg_id: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
      call_session_id: CALL_SESSION_ID,
      client_state: "aGF2ZSBhIG5pY2UgZGF5ID1d",
      from: CALLER,
      to: OUR_NUMBER,
      start_time: "2018-02-02T22:20:27.521992Z",
      state: "hangup",
      hangup_cause: "normal_clearing",
      hangup_source: "caller",
      sip_hangup_cause: "200",
      call_quality_stats: { inbound: { mos: "4.50", packet_count: "591" }, outbound: { packet_count: "0" } },
    },
  },
};

const callSpeakEnded = {
  data: {
    record_type: "event",
    event_type: "call.speak.ended",
    id: "3fff7b54-4df3-4bca-a65a-3da1ecc777f3",
    occurred_at: "2018-02-02T22:29:27.521992Z",
    payload: {
      call_control_id: CALL_CONTROL_ID,
      connection_id: "7267xxxxxxxxxxxxxx",
      call_leg_id: "428c31b6-7af4-4bcb-b7f5-5013ef9657c1",
      call_session_id: CALL_SESSION_ID,
      client_state: "aGF2ZSBhIG5pY2UgZGF5ID1d",
      status: "completed",
    },
  },
};

/** The catalogue's example is of an AI assistant's ending. Telnyx documents the same event for the Relay. */
const callConversationEnded = {
  data: {
    record_type: "event",
    event_type: "call.conversation.ended",
    id: "eb8775a6-634f-48b0-b177-d5465a8a8e9f",
    occurred_at: "2025-05-29T13:35:38.817785Z",
    created_at: "2025-05-29T13:35:38.927621Z",
    payload: {
      call_control_id: CALL_CONTROL_ID,
      call_leg_id: "cc29cce6-3c91-11f0-a8e5-02420aef3d20",
      call_session_id: CALL_SESSION_ID,
      calling_party_type: "pstn",
      client_state: null,
      connection_id: "2694492062593582591",
      conversation_id: "0424805b-adc1-4ff8-9f95-e1de6883ecbe",
      duration_sec: 3,
      from: CALLER,
      to: OUR_NUMBER,
      reason: "customer_disconnect",
      messages: [],
    },
  },
};

const raw = (payload: unknown) => JSON.stringify(payload);

/** `event` with its `data.payload` changed by `change`. */
function withPayload<T extends { data: { payload: Record<string, unknown> } }>(event: T, change: Record<string, unknown>): unknown {
  return { ...event, data: { ...event.data, payload: { ...event.data.payload, ...change } } };
}

describe("parseWebhookEvent", () => {
  it("reads the call arriving: both numbers, the direction and both of Telnyx's ids", () => {
    expect(parseWebhookEvent(raw(callInitiated))).toEqual({
      kind: "arrived",
      eventId: "0ccc7b54-4df3-4bca-a65a-3da1ecc777f0",
      occurredAt: "2018-02-02T22:25:27.521992Z",
      callControlId: CALL_CONTROL_ID,
      callSessionId: CALL_SESSION_ID,
      direction: "inbound",
      from: CALLER,
      to: OUR_NUMBER,
    });
  });

  it("reads the body as the bytes that were checked, too", () => {
    expect(parseWebhookEvent(Buffer.from(raw(callInitiated))).kind).toBe("arrived");
  });

  it("reads the call answered", () => {
    expect(parseWebhookEvent(raw(callAnswered))).toEqual({
      kind: "answered",
      eventId: "1ddd7b54-4df3-4bca-a65a-3da1ecc777f1",
      occurredAt: "2018-02-02T22:25:28.521992Z",
      callControlId: CALL_CONTROL_ID,
      callSessionId: CALL_SESSION_ID,
    });
  });

  it("reads the call hung up, with who hung up and why", () => {
    expect(parseWebhookEvent(raw(callHangup))).toEqual({
      kind: "hungUp",
      eventId: "2eee7b54-4df3-4bca-a65a-3da1ecc777f2",
      occurredAt: "2018-02-02T22:30:27.521992Z",
      callControlId: CALL_CONTROL_ID,
      callSessionId: CALL_SESSION_ID,
      cause: "normal_clearing",
      source: "caller",
    });
  });

  it("reads speech ended, with how it ended", () => {
    expect(parseWebhookEvent(raw(callSpeakEnded))).toEqual({
      kind: "speechEnded",
      eventId: "3fff7b54-4df3-4bca-a65a-3da1ecc777f3",
      occurredAt: "2018-02-02T22:29:27.521992Z",
      callControlId: CALL_CONTROL_ID,
      callSessionId: CALL_SESSION_ID,
      status: "completed",
    });
  });

  it("reads the Relay ended, with Telnyx's reason", () => {
    expect(parseWebhookEvent(raw(callConversationEnded))).toEqual({
      kind: "relayEnded",
      eventId: "eb8775a6-634f-48b0-b177-d5465a8a8e9f",
      occurredAt: "2025-05-29T13:35:38.817785Z",
      callControlId: CALL_CONTROL_ID,
      callSessionId: CALL_SESSION_ID,
      reason: "customer_disconnect",
    });
  });

  it("gives every event its event id, so a repeat can be told from a new one", () => {
    for (const payload of [callInitiated, callAnswered, callHangup, callSpeakEnded, callConversationEnded]) {
      const event = parseWebhookEvent(raw(payload));
      expect(event.kind === "malformed" ? undefined : event.eventId).toBe(payload.data.id);
    }
    const again = parseWebhookEvent(raw({ ...callInitiated, meta: { attempt: 2, delivered_to: "https://example.com/webhooks" } }));
    expect(again).toEqual(parseWebhookEvent(raw(callInitiated)));
  });

  it("gives an outgoing call its direction, so that only an inbound one is answered", () => {
    const outgoing = parseWebhookEvent(raw(withPayload(callInitiated, { direction: "outgoing", state: "bridging" })));
    expect(outgoing).toMatchObject({ kind: "arrived", direction: "outbound" });
  });

  it("takes the Relay's spelling of the direction as well as the webhook's", () => {
    expect(parseWebhookEvent(raw(withPayload(callInitiated, { direction: "inbound" })))).toMatchObject({ direction: "inbound" });
    expect(parseWebhookEvent(raw(withPayload(callInitiated, { direction: "outbound" })))).toMatchObject({ direction: "outbound" });
  });

  it("leaves a direction it does not know, and a number that was not given, as nothing", () => {
    const event = parseWebhookEvent(raw(withPayload(callInitiated, { direction: "sideways", from: "", to: undefined })));
    expect(event).toMatchObject({ kind: "arrived", callControlId: CALL_CONTROL_ID });
    expect(event).toHaveProperty("direction", undefined);
    expect(event).toHaveProperty("from", undefined);
    expect(event).toHaveProperty("to", undefined);
  });

  it("leaves the details of a hang-up, of speech ending and of the Relay ending as nothing when Telnyx sends none", () => {
    const hungUp = parseWebhookEvent(raw(withPayload(callHangup, { hangup_cause: undefined, hangup_source: null })));
    expect(hungUp).toMatchObject({ kind: "hungUp", cause: undefined, source: undefined });
    expect(parseWebhookEvent(raw(withPayload(callSpeakEnded, { status: undefined })))).toMatchObject({
      kind: "speechEnded",
      status: undefined,
    });
    expect(parseWebhookEvent(raw(withPayload(callConversationEnded, { reason: null })))).toMatchObject({
      kind: "relayEnded",
      reason: undefined,
    });
  });

  it("ignores an event type it has no use for, and says which it was", () => {
    const unused = ["call.speak.started", "call.conversation.start_failed", "call.dtmf.received", "streaming.started", "toString"];
    for (const eventType of unused) {
      const event = parseWebhookEvent(raw({ data: { record_type: "event", event_type: eventType, id: "event-9", payload: {} } }));
      expect(event).toEqual({ kind: "ignored", eventId: "event-9", eventType });
    }
  });

  it("ignores an unknown event type even when it has no id or payload", () => {
    expect(parseWebhookEvent(raw({ data: { event_type: "call.something.new" } }))).toEqual({
      kind: "ignored",
      eventId: undefined,
      eventType: "call.something.new",
    });
  });

  it("calls a body that is not a version 2 event malformed, and never throws", () => {
    const malformed = [
      "",
      "not json",
      "null",
      "[]",
      "42",
      raw({}),
      raw({ data: null }),
      raw({ data: [] }),
      raw({ data: { id: "event-1", payload: {} } }),
      raw({ data: { event_type: 7, id: "event-1" } }),
      // A version 1 webhook: the event type is at the top, with no `data`.
      raw({ event_type: "call_initiated", payload: { call_control_id: CALL_CONTROL_ID } }),
    ];
    for (const body of malformed) {
      expect(parseWebhookEvent(body), `body ${body}`).toEqual({ kind: "malformed", reason: expect.any(String) });
    }
  });

  it("calls a known event malformed when it lacks its event id or one of the call's ids", () => {
    const noEventId = { data: { ...callInitiated.data, id: undefined } };
    expect(parseWebhookEvent(raw(noEventId))).toEqual({ kind: "malformed", reason: "call.initiated has no event id" });
    expect(parseWebhookEvent(raw(withPayload(callAnswered, { call_control_id: undefined })))).toEqual({
      kind: "malformed",
      reason: "call.answered has no call_control_id",
    });
    expect(parseWebhookEvent(raw(withPayload(callHangup, { call_session_id: 12 })))).toEqual({
      kind: "malformed",
      reason: "call.hangup has no call_session_id",
    });
    expect(parseWebhookEvent(raw({ data: { ...callSpeakEnded.data, payload: "none" } }))).toEqual({
      kind: "malformed",
      reason: "call.speak.ended has no payload",
    });
  });

  it("repeats nothing from the body in the reason it gives", () => {
    const secretive = raw({ data: { event_type: "call.initiated", id: "event-1", payload: { from: CALLER, note: "PRIVATE" } } });
    const event = parseWebhookEvent(secretive);
    expect(event.kind).toBe("malformed");
    expect(JSON.stringify(event)).not.toContain(CALLER);
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
    expect(JSON.stringify(parseWebhookEvent(`{"data": PRIVATE`))).not.toContain("PRIVATE");
  });
});
