import { directionOf, isObject, jsonObject, text, type CallDirection, type JsonObject } from "./fields.js";

/**
 * Telnyx's version 2 webhooks, read into the few events a phone Call is built from. A webhook is
 * `{ data: { event_type, id, occurred_at, payload }, meta }`. Check its signature first (`checkWebhookSignature`) and
 * hand the same raw body to `parseWebhookEvent`.
 *
 * Telnyx may deliver an event twice, late or out of order, and says to tell a repeat by `data.id`, which is `eventId`
 * here. Its schemas mark no field as required, so every field is read as if it might be absent.
 */

/** What every event about a call carries. */
interface CallEvent {
  /** Telnyx's id of this event (`data.id`). A repeated delivery carries the same one. */
  eventId: string;
  /** When Telnyx says it happened (ISO 8601), for telling the order of events that arrive out of order. */
  occurredAt: string | undefined;
  /** Telnyx's id of the call leg, which every command is addressed to. Opaque: its form differs between examples. */
  callControlId: string;
  /** Telnyx's id of the whole call. The phone Channel uses it as the Call's id. */
  callSessionId: string;
}

/** `call.initiated`: a call has reached the number and waits to be answered or rejected. */
export interface CallArrived extends CallEvent {
  kind: "arrived";
  /** Undefined when Telnyx gives none or one this module does not know, so only a call marked inbound is answered. */
  direction: CallDirection | undefined;
  /**
   * The Caller's number as Telnyx gives it (E.164, or a SIP URI). Undefined when absent or empty. What Telnyx sends
   * for a withheld number is not documented: unconfirmed until the spike (#23).
   */
  from: string | undefined;
  /** The number that was called. */
  to: string | undefined;
}

/** `call.answered`: the call is up. The `answer` command's HTTP response can arrive before this does. */
export interface CallAnswered extends CallEvent {
  kind: "answered";
}

/** `call.hangup`: the call is over, whoever ended it. */
export interface CallHungUp extends CallEvent {
  kind: "hungUp";
  /** Telnyx's `hangup_cause`, such as `normal_clearing` or `call_rejected`. */
  cause: string | undefined;
  /** Telnyx's `hangup_source`: `caller`, `callee` or `unknown`. */
  source: string | undefined;
}

/** `call.speak.ended`: what a `speak` command said has finished playing, or was cut short. */
export interface SpeechEnded extends CallEvent {
  kind: "speechEnded";
  /**
   * Telnyx's `status`: `completed`, `call_hangup` or `cancelled_amd`. One `speak` is assumed to give one event; the
   * event names no command, so two `speak` commands on one call cannot be told apart by it.
   */
  status: string | undefined;
}

/**
 * `call.conversation.ended`: the Relay connection's side of the call is over. Telnyx documents one `reason`,
 * `customer_disconnect`, for when our WebSocket closed.
 *
 * Unconfirmed until the spike (#23): the Relay guide's example of this webhook shows only `event_type`, `reason` and
 * `record_type`, while the event catalogue's example (of an AI assistant) has the event id and the call's ids like any
 * other event. This reads it like any other event, so one that really arrives without ids is `malformed`.
 */
export interface RelayEnded extends CallEvent {
  kind: "relayEnded";
  reason: string | undefined;
}

/**
 * An event type nothing here acts on, such as `call.speak.started`. It is not an error. `call.conversation.start_failed`
 * is ignored too: Telnyx documents it for AI assistants only, not for the Relay.
 */
export interface IgnoredEvent {
  kind: "ignored";
  eventId: string | undefined;
  eventType: string;
}

/** A body that is not a version 2 event, or a known event without the ids that tie it to a call. */
export interface MalformedEvent {
  kind: "malformed";
  /** For the terminal. It names what is missing and repeats nothing from the body. */
  reason: string;
}

export type TelnyxEvent = CallArrived | CallAnswered | CallHungUp | SpeechEnded | RelayEnded | IgnoredEvent | MalformedEvent;

/** The details each known event type adds to the ids, read from the event's `payload`. */
const KNOWN: Record<string, (ids: CallEvent, payload: JsonObject) => TelnyxEvent> = {
  "call.initiated": (ids, payload) => ({
    kind: "arrived",
    ...ids,
    direction: directionOf(payload.direction),
    from: text(payload.from),
    to: text(payload.to),
  }),
  "call.answered": (ids) => ({ kind: "answered", ...ids }),
  "call.hangup": (ids, payload) => ({
    kind: "hungUp",
    ...ids,
    cause: text(payload.hangup_cause),
    source: text(payload.hangup_source),
  }),
  "call.speak.ended": (ids, payload) => ({ kind: "speechEnded", ...ids, status: text(payload.status) }),
  "call.conversation.ended": (ids, payload) => ({ kind: "relayEnded", ...ids, reason: text(payload.reason) }),
};

/**
 * Reads one webhook body. Never throws: a body that cannot be read is `malformed`, and an event type with no use here
 * is `ignored`. The body is not trusted until its signature has been checked, and this does not check it.
 */
export function parseWebhookEvent(rawBody: string | Uint8Array): TelnyxEvent {
  const body = jsonObject(rawBody);
  if (!body) return { kind: "malformed", reason: "the body is not a JSON object" };
  // A version 1 webhook has no `data`. The Voice API application must be set to webhook API version 2.
  if (!isObject(body.data)) return { kind: "malformed", reason: "the body has no data object, so it is not a version 2 webhook" };
  const { data } = body;
  const eventType = text(data.event_type);
  if (eventType === undefined) return { kind: "malformed", reason: "the event has no event_type" };
  const eventId = text(data.id);

  const read = Object.hasOwn(KNOWN, eventType) ? KNOWN[eventType] : undefined;
  if (!read) return { kind: "ignored", eventId, eventType };

  if (eventId === undefined) return { kind: "malformed", reason: `${eventType} has no event id` };
  if (!isObject(data.payload)) return { kind: "malformed", reason: `${eventType} has no payload` };
  const callControlId = text(data.payload.call_control_id);
  if (callControlId === undefined) return { kind: "malformed", reason: `${eventType} has no call_control_id` };
  const callSessionId = text(data.payload.call_session_id);
  if (callSessionId === undefined) return { kind: "malformed", reason: `${eventType} has no call_session_id` };

  return read({ eventId, occurredAt: text(data.occurred_at), callControlId, callSessionId }, data.payload);
}
