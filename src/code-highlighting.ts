import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Lezer syntax categories use colors from Dark Modern or the local VS Code theme.
export const vscodeHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)' },
  { tag: tags.controlKeyword, color: 'var(--syntax-control)' },
  { tag: [tags.operatorKeyword, tags.definitionKeyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syntax-type)' },
  { tag: tags.standard(tags.typeName), color: 'var(--syntax-keyword)' },
  { tag: [tags.variableName, tags.propertyName], color: 'var(--syntax-variable)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
  { tag: [tags.constant(tags.variableName), tags.constant(tags.propertyName)], color: 'var(--syntax-constant)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--syntax-number)' },
  { tag: [tags.string, tags.character], color: 'var(--syntax-string)' },
  { tag: [tags.bool, tags.null], color: 'var(--syntax-keyword)' },
  { tag: [tags.comment, tags.docComment], color: 'var(--syntax-comment)' },
  { tag: tags.operator, color: 'var(--syntax-operator)' },
  { tag: tags.punctuation, color: 'var(--syntax-punctuation)' },
  { tag: tags.meta, color: 'var(--syntax-keyword)' },
  { tag: tags.invalid, textDecoration: 'underline wavy #f85149' },
]);
