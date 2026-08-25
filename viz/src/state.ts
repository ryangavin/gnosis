export interface ViewState {
  expanded: Set<string>;
  selected?: string;
  /** The node whose neighborhood the camera should settle on after relayout. */
  focus?: string;
  showTests: boolean;
}

export type Action =
  | { type: 'toggle'; id: string }
  | { type: 'select'; id?: string }
  | { type: 'reveal'; id: string; ancestors: string[] }
  | { type: 'collapseAll' }
  | { type: 'showTests'; value: boolean };

export const initialState: ViewState = {
  expanded: new Set(),
  showTests: false,
};

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'toggle': {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.id)) expanded.delete(action.id);
      else expanded.add(action.id);
      return { ...state, expanded, focus: action.id };
    }
    case 'select':
      return { ...state, selected: action.id };
    case 'reveal': {
      const expanded = new Set(state.expanded);
      for (const id of action.ancestors) expanded.add(id);
      return { ...state, expanded, selected: action.id, focus: action.id };
    }
    case 'collapseAll':
      return { ...state, expanded: new Set(), selected: undefined, focus: undefined };
    case 'showTests':
      return { ...state, showTests: action.value, focus: undefined };
  }
}
