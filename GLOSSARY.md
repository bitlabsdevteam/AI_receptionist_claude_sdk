# Receptionist

An AI voice receptionist that answers callers, works out what they need, and moves them through a conversation. It is modelled on Telnyx-style AI Assistant workflows.

## Language

**Caller**:
The person talking to the Receptionist.
_Avoid_: User, customer, client

**Receptionist**:
The AI persona the Caller talks to. Its name and company are configurable (placeholder: "Ava" at "Acme Co.").
_Avoid_: Bot, agent, assistant

**Call**:
One conversation between a Caller and the Receptionist, from the Receptionist's greeting until the Call ends. This holds for typed chat as well as phone.
_Avoid_: Session, conversation, chat

**Channel**:
The way a Caller reaches the Receptionist: typed in the terminal, spoken in the terminal, or by phone. A Call takes place on one Channel.
_Avoid_: Medium, interface, transport

**Flow**:
The complete definition of how a Call can unfold: its Nodes, the Edges between them, and the ways it can end.
_Avoid_: Workflow, script, conversation tree

**Node**:
One stage of a Flow, with its own instructions for how the Receptionist behaves at that stage.
_Avoid_: Step, state, block

**Edge**:
A possible move from one Node to another (or to an end of the Call), taken when its condition holds.
_Avoid_: Transition, link, route

**End state**:
A named way a Call can finish, with a fixed closing message the Receptionist speaks. The first one is `goodbye`.
_Avoid_: Outcome, terminal node, exit

**Turn**:
One Caller utterance and the Receptionist's reply to it.
_Avoid_: Message, exchange

**Voice**:
How the Receptionist is heard and the Caller is understood on a spoken Call: speech in and speech out. Typed chat has no Voice.
_Avoid_: TTS engine, speech tool, audio layer

**Relay connection**:
The WebSocket that Telnyx opens to the receptionist's server for one phone Call. The Caller's words arrive on it as text and the Receptionist's replies go back on it. It belongs to the Call only once its first message names that Call.
_Avoid_: Stream, socket, media stream

**Relay token**:
The single-use secret in the address of a Relay connection. It is issued for one Call, valid for 30 seconds, and says which Call a connection may ask to join.
_Avoid_: Session key, auth token, API key

## Harness

**Harness**:
Everything around the model that makes it dependable on a Call: what it is shown, what it may do, the rules that always hold, and the means of measuring it.
_Avoid_: Wrapper, framework, orchestrator

**Guard**:
A rule that always holds whatever the model says, such as "a Caller is never verified unless the identity check passed".
_Avoid_: Guardrail, validator, filter

**Trace**:
The record of how the Harness handled one Turn: what happened, how long it took, and which Guards allowed or rejected what.
_Avoid_: Log, audit trail

**Scenario**:
A scripted situation a Caller might create, together with what must be true when the Call ends.
_Avoid_: Test case, script

**Simulated Caller**:
A model playing the Caller in a Scenario, knowing only what a real Caller would know.
_Avoid_: Fake user, test bot
