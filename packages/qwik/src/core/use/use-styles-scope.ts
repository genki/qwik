import type {QRL} from "../qrl/qrl.public";
import {implicit$FirstArg} from "../util/implicit_dollar";
import {ComponentStylesPrefixContent} from "../util/markers";
import {_useStyles, type UseStylesScoped} from "./use-styles";

/** @public */
export const useStylesWithScopeQrl = (styles: QRL<string>): UseStylesScoped => {
  const styleId = _useStyles(
    styles,
    (str, styleId) => {
      const scopeId = ComponentStylesPrefixContent + styleId;
      return str.replaceAll(/:scope\b/g, '.' + scopeId);
    },
    true
  );
  return {scopeId: ComponentStylesPrefixContent + styleId};
}


/** @public */
export const useStylesWithScope$ = /*#__PURE__*/ implicit$FirstArg(useStylesWithScopeQrl);
