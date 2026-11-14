/** A side effect for the channel adapter to perform (transfer, hang up). Reserved for later. */
export interface Action {
  type: string;
}

/** What the Receptionist did with one Turn. Stored on the Call, so a replayed Turn returns it unchanged. */
export interface TurnResult {
  /** Text to speak or display. Never empty. */
  reply: string;
  /** The Node (or End state) the Call is at after this Turn. */
  nodeId: string;
  /** True once an End state is reached. */
  ended: boolean;
  endState?: string;
  actions: Action[];
}
