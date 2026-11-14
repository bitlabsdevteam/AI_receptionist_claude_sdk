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
