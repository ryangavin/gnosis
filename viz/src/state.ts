export interface ViewState {
  selected?: string;
  /** The node the camera should travel to; nonce retriggers travel to the same id. */
  focus?: string;
  focusNonce: number;
  showTests: boolean;
}

export type Action =
  | { type: 'select'; id?: string }
  | { type: 'reveal'; id: string }
  | { type: 'showTests'; value: boolean };

export const initialState: ViewState = {
  focusNonce: 0,
  showTests: false,
};

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'select':
      return { ...state, selected: action.id };
    case 'reveal':
      return { ...state, selected: action.id, focus: action.id, focusNonce: state.focusNonce + 1 };
    case 'showTests':
      return { ...state, showTests: action.value };
  }
}
