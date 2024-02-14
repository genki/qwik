import {
  type Component,
  componentQrl,
  isQwikComponent,
  type OnRenderFn,
} from '../component/component.public';
import { parseQRL, serializeQRL } from '../qrl/qrl';
import { isQrl, type QRLInternal } from '../qrl/qrl-class';
import { intToStr, type ContainerState, type GetObject, type MustGetObjID } from './container';
import { isResourceReturn, parseResourceReturn, serializeResource } from '../use/use-resource';
import {
  isSubscriberDescriptor,
  parseTask,
  type ResourceReturnInternal,
  serializeTask,
  type SubscriberEffect,
} from '../use/use-task';
import { isDocument } from '../util/element';
import {
  QObjectSignalFlags,
  SIGNAL_IMMUTABLE,
  SignalDerived,
  SignalImpl,
  SignalWrapper,
} from '../state/signal';
import { type Collector, collectSubscriptions, collectValue, mapJoin } from './pause';
import {
  fastWeakSerialize,
  getSubscriptionManager,
  LocalSubscriptionManager,
  type SubscriptionManager,
  type Subscriptions,
} from '../state/common';
import { getOrCreateProxy } from '../state/store';
import { QObjectManagerSymbol } from '../state/constants';
import { serializeDerivedSignalFunc } from '../qrl/inlined-fn';
import type { QwikElement } from '../render/dom/virtual-element';
import { assertString, assertTrue } from '../error/assert';
import { Fragment, JSXNodeImpl, isJSXNode } from '../render/jsx/jsx-runtime';
import type { JSXNode } from '@builder.io/qwik/jsx-runtime';
import { Slot } from '../render/jsx/slot.public';

/**
 * - 0, 8, 9, A, B, C, D
 * - `\0`: null character (U+0000 NULL) (only if the next character is not a decimal digit; else it’s
 *   an octal escape sequence)
 * - `\b`: backspace (U+0008 BACKSPACE)
 * - `\t`: horizontal tab (U+0009 CHARACTER TABULATION)
 * - `\n`: line feed (U+000A LINE FEED)
 * - `\v`: vertical tab (U+000B LINE TABULATION)
 * - `\f`: form feed (U+000C FORM FEED)
 * - `\r`: carriage return (U+000D CARRIAGE RETURN)
 * - `\"`: double quote (U+0022 QUOTATION MARK)
 * - `\'`: single quote (U+0027 APOSTROPHE)
 * - `\\`: backslash (U+005C REVERSE SOLIDUS)
 */
export const UNDEFINED_PREFIX = '\u0001';

export interface Serializer<T> {
  $prefixCode$: number;
  $prefixChar$: string;
  /** Return true if this serializer can serialize the given object. */
  $test$: (obj: any) => boolean;
  /** Convert the object to a string. */
  $serialize$:
    | ((
        obj: T,
        getObjID: MustGetObjID,
        collector: Collector,
        containerState: ContainerState
      ) => string)
    | undefined;

  /** Return of */
  $collect$: undefined | ((obj: T, collector: Collector, leaks: boolean | QwikElement) => void);

  /** Deserialize the object. */
  $prepare$: (data: string, containerState: ContainerState, doc: Document) => T;
  /** Second pass to fill in the object. */
  $subs$: undefined | ((obj: T, subs: Subscriptions[], containerState: ContainerState) => void);

  /** Second pass to fill in the object. */
  $fill$: ((obj: T, getObject: GetObject, containerState: ContainerState) => void) | undefined;
}

/**
 * Normalize the shape of the serializer for better inline-cache performance.
 *
 * @param serializer
 * @returns
 */
function serializer<T>(serializer: {
  $prefix$: string;
  $test$: Serializer<T>['$test$'];
  $serialize$: Serializer<T>['$serialize$'];
  $prepare$: Serializer<T>['$prepare$'];
  $fill$: Serializer<T>['$fill$'];
  $collect$?: Serializer<T>['$collect$'];
  $subs$?: Serializer<T>['$subs$'];
}): Serializer<T> {
  return {
    $prefixCode$: serializer.$prefix$.charCodeAt(0),
    $prefixChar$: serializer.$prefix$,
    $test$: serializer.$test$,
    $serialize$: serializer.$serialize$,
    $prepare$: serializer.$prepare$,
    $fill$: serializer.$fill$,
    $collect$: serializer.$collect$,
    $subs$: serializer.$subs$,
  };
}

const QRLSerializer = /*#__PURE__*/ serializer<QRLInternal>({
  $prefix$: '\u0002',
  $test$: (v) => isQrl(v),
  $collect$: (v, collector, leaks) => {
    if (v.$captureRef$) {
      for (const item of v.$captureRef$) {
        collectValue(item, collector, leaks);
      }
    }
    if (collector.$prefetch$ === 0) {
      collector.$qrls$.push(v);
    }
  },
  $serialize$: (obj, getObjId) => {
    return serializeQRL(obj, {
      $getObjId$: getObjId,
    });
  },
  $prepare$: (data, containerState) => {
    return parseQRL(data, containerState.$containerEl$);
  },
  $fill$: (qrl, getObject) => {
    if (qrl.$capture$ && qrl.$capture$.length > 0) {
      qrl.$captureRef$ = qrl.$capture$.map(getObject);
      qrl.$capture$ = null;
    }
  },
});

const TaskSerializer = /*#__PURE__*/ serializer<SubscriberEffect>({
  $prefix$: '\u0003',
  $test$: (v) => isSubscriberDescriptor(v),
  $collect$: (v, collector, leaks) => {
    collectValue(v.$qrl$, collector, leaks);
    if (v.$state$) {
      collectValue(v.$state$, collector, leaks);
      if (leaks === true && v.$state$ instanceof SignalImpl) {
        collectSubscriptions(v.$state$[QObjectManagerSymbol], collector, true);
      }
    }
  },
  $serialize$: (obj, getObjId) => serializeTask(obj, getObjId),
  $prepare$: (data) => parseTask(data) as any,
  $fill$: (task, getObject) => {
    task.$el$ = getObject(task.$el$ as any);
    task.$qrl$ = getObject(task.$qrl$ as any);
    if (task.$state$) {
      task.$state$ = getObject(task.$state$ as any);
    }
  },
});

const ResourceSerializer = /*#__PURE__*/ serializer<ResourceReturnInternal<any>>({
  $prefix$: '\u0004',
  $test$: (v) => isResourceReturn(v),
  $collect$: (obj, collector, leaks) => {
    collectValue(obj.value, collector, leaks);
    collectValue(obj._resolved, collector, leaks);
  },
  $serialize$: (obj, getObjId) => {
    return serializeResource(obj, getObjId);
  },
  $prepare$: (data) => {
    return parseResourceReturn(data);
  },
  $fill$: (resource, getObject) => {
    if (resource._state === 'resolved') {
      resource._resolved = getObject(resource._resolved);
      resource.value = Promise.resolve(resource._resolved);
    } else if (resource._state === 'rejected') {
      const p = Promise.reject(resource._error);
      p.catch(() => null);
      resource._error = getObject(resource._error as any as string);
      resource.value = p;
    }
  },
});

const URLSerializer = /*#__PURE__*/ serializer<URL>({
  $prefix$: '\u0005',
  $test$: (v) => v instanceof URL,
  $serialize$: (obj) => obj.href,
  $prepare$: (data) => new URL(data),
  $fill$: undefined,
});

const DateSerializer = /*#__PURE__*/ serializer<Date>({
  $prefix$: '\u0006',
  $test$: (v) => v instanceof Date,
  $serialize$: (obj) => obj.toISOString(),
  $prepare$: (data) => new Date(data),
  $fill$: undefined,
});

const RegexSerializer = /*#__PURE__*/ serializer<RegExp>({
  $prefix$: '\u0007',
  $test$: (v) => v instanceof RegExp,
  $serialize$: (obj) => `${obj.flags} ${obj.source}`,
  $prepare$: (data) => {
    const space = data.indexOf(' ');
    const source = data.slice(space + 1);
    const flags = data.slice(0, space);
    return new RegExp(source, flags);
  },
  $fill$: undefined,
});

const ErrorSerializer = /*#__PURE__*/ serializer<Error>({
  $prefix$: '\u000E',
  $test$: (v) => v instanceof Error,
  $serialize$: (obj) => {
    return obj.message;
  },
  $prepare$: (text) => {
    const err = new Error(text);
    err.stack = undefined;
    return err;
  },
  $fill$: undefined,
});

const DocumentSerializer = /*#__PURE__*/ serializer<Document>({
  $prefix$: '\u000F',
  $test$: (v) => isDocument(v),
  $serialize$: undefined,
  $prepare$: (_, _c, doc) => {
    return doc;
  },
  $fill$: undefined,
});

export const SERIALIZABLE_STATE = Symbol('serializable-data');
const ComponentSerializer = /*#__PURE__*/ serializer<Component<any>>({
  $prefix$: '\u0010',
  $test$: (obj) => isQwikComponent(obj),
  $serialize$: (obj, getObjId) => {
    const [qrl]: [QRLInternal] = (obj as any)[SERIALIZABLE_STATE];
    return serializeQRL(qrl, {
      $getObjId$: getObjId,
    });
  },
  $prepare$: (data, containerState) => {
    const qrl = parseQRL<OnRenderFn<any>>(data, containerState.$containerEl$);
    return componentQrl(qrl);
  },
  $fill$: (component, getObject) => {
    const [qrl]: [QRLInternal] = (component as any)[SERIALIZABLE_STATE];
    if (qrl.$capture$ && qrl.$capture$.length > 0) {
      qrl.$captureRef$ = qrl.$capture$.map(getObject);
      qrl.$capture$ = null;
    }
  },
});

const DerivedSignalSerializer = /*#__PURE__*/ serializer<SignalDerived<any, any[]>>({
  $prefix$: '\u0011',
  $test$: (obj) => obj instanceof SignalDerived,
  $collect$: (obj, collector, leaks) => {
    if (obj.$args$) {
      for (const arg of obj.$args$) {
        collectValue(arg, collector, leaks);
      }
    }
  },
  $serialize$: (signal, getObjID, collector) => {
    const serialized = serializeDerivedSignalFunc(signal);
    let index = collector.$inlinedFunctions$.indexOf(serialized);
    if (index < 0) {
      collector.$inlinedFunctions$.push(serialized);
      index = collector.$inlinedFunctions$.length - 1;
    }
    return mapJoin(signal.$args$, getObjID, ' ') + ' @' + intToStr(index);
  },
  $prepare$: (data) => {
    const ids = data.split(' ');
    const args = ids.slice(0, -1);
    const fn = ids[ids.length - 1];
    return new SignalDerived(fn as any, args, fn);
  },
  $fill$: (fn, getObject) => {
    assertString(fn.$func$, 'fn.$func$ should be a string');
    fn.$func$ = getObject(fn.$func$);
    fn.$args$ = fn.$args$.map(getObject);
  },
});

const SignalSerializer = /*#__PURE__*/ serializer<SignalImpl<any>>({
  $prefix$: '\u0012',
  $test$: (v) => v instanceof SignalImpl,
  $collect$: (obj, collector, leaks) => {
    collectValue(obj.untrackedValue, collector, leaks);
    const mutable = (obj[QObjectSignalFlags] & SIGNAL_IMMUTABLE) === 0;
    if (leaks === true && mutable) {
      collectSubscriptions(obj[QObjectManagerSymbol], collector, true);
    }
    return obj;
  },
  $serialize$: (obj, getObjId) => {
    return getObjId(obj.untrackedValue);
  },
  $prepare$: (data, containerState) => {
    return new SignalImpl(data, containerState?.$subsManager$?.$createManager$(), 0);
  },
  $subs$: (signal, subs) => {
    signal[QObjectManagerSymbol].$addSubs$(subs);
  },
  $fill$: (signal, getObject) => {
    signal.untrackedValue = getObject(signal.untrackedValue);
  },
});

const SignalWrapperSerializer = /*#__PURE__*/ serializer<SignalWrapper<any, any>>({
  $prefix$: '\u0013',
  $test$: (v) => v instanceof SignalWrapper,
  $collect$(obj, collector, leaks) {
    collectValue(obj.ref, collector, leaks);
    if (fastWeakSerialize(obj.ref)) {
      const localManager = getSubscriptionManager(obj.ref)!;
      if (isTreeShakeable(collector.$containerState$.$subsManager$, localManager, leaks)) {
        collectValue(obj.ref[obj.prop], collector, leaks);
      }
    }
    return obj;
  },
  $serialize$: (obj, getObjId) => {
    return `${getObjId(obj.ref)} ${obj.prop}`;
  },
  $prepare$: (data) => {
    const [id, prop] = data.split(' ');
    return new SignalWrapper(id as any, prop);
  },
  $fill$: (signal, getObject) => {
    signal.ref = getObject(signal.ref);
  },
});

const NoFiniteNumberSerializer = /*#__PURE__*/ serializer<number>({
  $prefix$: '\u0014',
  $test$: (v) => typeof v === 'number',
  $serialize$: (v) => {
    return String(v);
  },
  $prepare$: (data) => {
    return Number(data);
  },
  $fill$: undefined,
});

const URLSearchParamsSerializer = /*#__PURE__*/ serializer<URLSearchParams>({
  $prefix$: '\u0015',
  $test$: (v) => v instanceof URLSearchParams,
  $serialize$: (obj) => obj.toString(),
  $prepare$: (data) => new URLSearchParams(data),
  $fill$: undefined,
});

const FormDataSerializer = /*#__PURE__*/ serializer<FormData>({
  $prefix$: '\u0016',
  $test$: (v) => typeof FormData !== 'undefined' && v instanceof globalThis.FormData,
  $serialize$: (formData) => {
    const array: [string, string][] = [];
    formData.forEach((value, key) => {
      if (typeof value === 'string') {
        array.push([key, value]);
      } else {
        array.push([key, value.name]);
      }
    });
    return JSON.stringify(array);
  },
  $prepare$: (data) => {
    const array = JSON.parse(data);
    const formData = new FormData();
    for (const [key, value] of array) {
      formData.append(key, value);
    }
    return formData;
  },
  $fill$: undefined,
});

const JSXNodeSerializer = /*#__PURE__*/ serializer<JSXNode>({
  $prefix$: '\u0017',
  $test$: (v) => isJSXNode(v),
  $collect$: (node, collector, leaks) => {
    collectValue(node.children, collector, leaks);
    collectValue(node.props, collector, leaks);
    collectValue(node.immutableProps, collector, leaks);
    let type = node.type;
    if (type === Slot) {
      type = ':slot';
    } else if (type === Fragment) {
      type = ':fragment';
    }
    collectValue(type, collector, leaks);
  },
  $serialize$: (node, getObjID) => {
    let type = node.type;
    if (type === Slot) {
      type = ':slot';
    } else if (type === Fragment) {
      type = ':fragment';
    }
    return `${getObjID(type)} ${getObjID(node.props)} ${getObjID(node.immutableProps)} ${getObjID(
      node.children
    )} ${node.flags}`;
  },
  $prepare$: (data) => {
    const [type, props, immutableProps, children, flags] = data.split(' ');
    const node = new JSXNodeImpl(
      type as string,
      props as any,
      immutableProps as any,
      children,
      parseInt(flags, 10)
    );
    return node;
  },
  $fill$: (node, getObject) => {
    node.type = getResolveJSXType(getObject(node.type as string));
    node.props = getObject(node.props as any as string);
    node.immutableProps = getObject(node.immutableProps as any as string);
    node.children = getObject(node.children as string);
  },
});

const BigIntSerializer = /*#__PURE__*/ serializer<bigint>({
  $prefix$: '\u0018',
  $test$: (v) => typeof v === 'bigint',
  $serialize$: (v) => {
    return v.toString();
  },
  $prepare$: (data) => {
    return BigInt(data);
  },
  $fill$: undefined,
});

// pack bytes into valid UTF-16 string
//
// strategy:
//
// * using 0xFFFD as the escape character
//  * if there is 0xFFFD in the bytes, double it
// * if there is unmatched surrogate pair, mark it by the escape character
// * and put a fake surrogate pair to make it valid
//  * 0xD800 for fake high surrogate to be with unmatched low surrogate
//  * 0xDC00 for fake low surrogate to be with unmatched high surrogate
//
// if the unmatched high surrogate is 0xD800, it is collided with the fake
// high surrogate, so use [0xD801, 0xDC01] as the fake surrogate pair
// representing the 0xD800.
//
// If the length of the bytes is odd, the last byte is put after the escape
// character. As the bytes after the escape character are in 0xD800 to 0xDFFF,
// we can distingwish the last byte by its high byte being 0x00.
//
export const packUint8Array = (bytes:Uint8Array) => {
  const odd = bytes.length % 2 === 1;
  const dbytes = new Uint16Array(bytes.buffer, 0, bytes.length >> 1);
  let code = '';
  let surrogate = false;
  for (let i = 0; i < dbytes.length; i++) {
    const c = dbytes[i];
    // test high surrogate
    if (c >= 0xD800 && c <= 0xDBFF) {
      if (surrogate) { // unmatched high surrogate
        const prev = dbytes[i - 1];
        const [hi, lo] = prev === 0xD800 ? [0xD801, 0xDC01] : [prev, 0xDC00];
        // put the 0xFFFD and the fake surrogate pair to make it valid
        code += String.fromCharCode(0xFFFD, hi, lo);
        // keep surrogate is true because c is high surrogate
      }
      surrogate = true;
      continue;
    }
    // test low surrogate
    if (c >= 0xDC00 && c <= 0xDFFF) {
      if (surrogate) { // valid surrogate pair
        code += String.fromCharCode(dbytes[i - 1], c);
        surrogate = false;
        continue;
      }
      // unmatched low surrogate
      // put the 0xFFFD and the fake high surrogate to make it valid
      code += String.fromCharCode(0xFFFD, 0xD800, c);
      continue;
    }
    if (surrogate) { // no low surrogate after high surrogate
      const prev = dbytes[i - 1];
      const [hi, lo] = prev === 0xD800 ? [0xD801, 0xDC01] : [prev, 0xDC00];
      // put the 0xFFFD and the fake surrogate pair to make it valid
      code += String.fromCharCode(0xFFFD, hi, lo);
      surrogate = false; // reset surrogate
    }
    // double the escape character
    if (c === 0xFFFD) {
      code += String.fromCharCode(0xFFFD);
    }
    // normal codepoint
    code += String.fromCharCode(c);
  }
  if (surrogate) { // ended with unmatched high surrogate
    const c = dbytes[dbytes.length - 1];
    const [hi, lo] = c === 0xD800 ? [0xD801, 0xDC01] : [c, 0xDC00];
    code += String.fromCharCode(0xFFFD, hi, lo);
  }
  if (odd) {
    // put the last byte
    code += String.fromCharCode(0xFFFD, bytes[bytes.length - 1]);
  }
  return code;
};

// unpack encoded valid UTF-16 string into Uint8Array
export const unpackUint8Array = (code:string) => {
  const dbytes = new Uint16Array(code.length);
  let j = 0;
  let escaped = false;
  for (let i = 0; i < code.length; i++) {
    const c = code.charCodeAt(i);
    // check the replacement character
    if (c === 0xFFFD) {
      if (escaped) {
        dbytes[j++] = 0xFFFD; // unescape the escape character
        escaped = false;
        continue;
      }
      escaped = true;
      continue;
    } else if (escaped && (c & 0xFF00) === 0) { // test the last byte
      dbytes[j++] = c;
      break; // break with escaped being true to adjust the length
    }
    if (c >= 0xD800 && c <= 0xDBFF && escaped) { // faked high surrogate
      if (c === 0xD800) { // escaped low surrogate
        i++; // skip the fake high surrogate
        dbytes[j++] = code.charCodeAt(i); // save the low surrogate
      } else if (c === 0xD801 && code.charCodeAt(i + 1) === 0xDC01) {
        i++; // skip the fake low surrogate
        dbytes[j++] = 0xD800; // save the escaped 0xD800
      } else { // escaped high surrogate
        dbytes[j++] = code.charCodeAt(i); // save the high surrogate
        i++; // skip the fake low surrogate
      }
      escaped = false;
      continue;
    }
    // normal codepoint
    dbytes[j++] = c;
  }
  // if ended while escaped, the length is odd
  const length = j*2 - (escaped ? 1 : 0);
  return new Uint8Array(dbytes.subarray(0, j).buffer).subarray(0, length);
};

const Uint8ArraySerializer = /*#__PURE__*/ serializer<Uint8Array>({
  $prefix$: '\u001c',
  $test$: (v) => v instanceof Uint8Array,
  $serialize$: (v) => packUint8Array(v),
  $prepare$: (data) => unpackUint8Array(data),
  $fill$: undefined,
});

const DATA = Symbol();
const SetSerializer = /*#__PURE__*/ serializer<Set<any>>({
  $prefix$: '\u0019',
  $test$: (v) => v instanceof Set,
  $collect$: (set, collector, leaks) => {
    set.forEach((value) => collectValue(value, collector, leaks));
  },
  $serialize$: (v, getObjID) => {
    return Array.from(v).map(getObjID).join(' ');
  },
  $prepare$: (data) => {
    const set = new Set();
    (set as any)[DATA] = data;
    return set;
  },
  $fill$: (set, getObject) => {
    const data = (set as any)[DATA];
    (set as any)[DATA] = undefined;
    assertString(data, 'SetSerializer should be defined');
    const items = data.length === 0 ? [] : data.split(' ');
    for (const id of items) {
      set.add(getObject(id));
    }
  },
});

const MapSerializer = /*#__PURE__*/ serializer<Map<any, any>>({
  $prefix$: '\u001a',
  $test$: (v) => v instanceof Map,
  $collect$: (map, collector, leaks) => {
    map.forEach((value, key) => {
      collectValue(value, collector, leaks);
      collectValue(key, collector, leaks);
    });
  },
  $serialize$: (map, getObjID) => {
    const result: string[] = [];
    map.forEach((value, key) => {
      result.push(getObjID(key) + ' ' + getObjID(value));
    });
    return result.join(' ');
  },
  $prepare$: (data) => {
    const set = new Map();
    (set as any)[DATA] = data;
    return set;
  },
  $fill$: (set, getObject) => {
    const data = (set as any)[DATA];
    (set as any)[DATA] = undefined;
    assertString(data, 'SetSerializer should be defined');
    const items = data.length === 0 ? [] : data.split(' ');
    assertTrue(items.length % 2 === 0, 'MapSerializer should have even number of items');
    for (let i = 0; i < items.length; i += 2) {
      set.set(getObject(items[i]), getObject(items[i + 1]));
    }
  },
});

const StringSerializer = /*#__PURE__*/ serializer<string>({
  $prefix$: '\u001b',
  $test$: (v) => !!getSerializer(v) || v === UNDEFINED_PREFIX,
  $serialize$: (v) => v,
  $prepare$: (data) => data,
  $fill$: undefined,
});

const serializers: Serializer<any>[] = /*#__PURE__*/ [
  // NULL                       \u0000
  // UNDEFINED_PREFIX           \u0001
  QRLSerializer, ////////////// \u0002
  TaskSerializer, ///////////// \u0003
  ResourceSerializer, ///////// \u0004
  URLSerializer, ////////////// \u0005
  DateSerializer, ///////////// \u0006
  RegexSerializer, //////////// \u0007
  // BACKSPACE                  \u0008
  // HORIZONTAL TAB             \u0009
  // NEW LINE                   \u000A
  // VERTICAL TAB               \u000B
  // FORM FEED                  \u000C
  // CARRIAGE RETURN            \u000D
  ErrorSerializer, //////////// \u000E
  DocumentSerializer, ///////// \u000F
  ComponentSerializer, //////// \u0010
  DerivedSignalSerializer, //// \u0011
  SignalSerializer, /////////// \u0012
  SignalWrapperSerializer, //// \u0013
  NoFiniteNumberSerializer, /// \u0014
  URLSearchParamsSerializer, // \u0015
  FormDataSerializer, ///////// \u0016
  JSXNodeSerializer, ////////// \u0017
  BigIntSerializer, /////////// \u0018
  SetSerializer, ////////////// \u0019
  MapSerializer, ////////////// \u001a
  StringSerializer, /////////// \u001b
  Uint8ArraySerializer,  ////// \u001c
];

const serializerByPrefix: (Serializer<unknown> | undefined)[] = /*#__PURE__*/ (() => {
  const serializerByPrefix: (Serializer<unknown> | undefined)[] = [];
  serializers.forEach((s) => {
    const prefix = s.$prefixCode$;
    while (serializerByPrefix.length < prefix) {
      serializerByPrefix.push(undefined);
    }
    serializerByPrefix.push(s);
  });
  return serializerByPrefix;
})();

export function getSerializer(obj: any): Serializer<unknown> | undefined {
  if (typeof obj === 'string') {
    const prefix = obj.charCodeAt(0);
    if (prefix < serializerByPrefix.length) {
      return serializerByPrefix[prefix];
    }
  }
  return undefined;
}

const collectorSerializers = /*#__PURE__*/ serializers.filter((a) => a.$collect$);

export const canSerialize = (obj: any): boolean => {
  for (const s of serializers) {
    if (s.$test$(obj)) {
      return true;
    }
  }
  return false;
};

export const collectDeps = (obj: any, collector: Collector, leaks: boolean | QwikElement) => {
  for (const s of collectorSerializers) {
    if (s.$test$(obj)) {
      s.$collect$!(obj, collector, leaks);
      return true;
    }
  }
  return false;
};

export const serializeValue = (
  obj: any,
  getObjID: MustGetObjID,
  collector: Collector,
  containerState: ContainerState
) => {
  for (const s of serializers) {
    if (s.$test$(obj)) {
      let value = s.$prefixChar$;
      if (s.$serialize$) {
        value += s.$serialize$(obj, getObjID, collector, containerState);
      }
      return value;
    }
  }
  if (typeof obj === 'string') {
    return obj;
  }
  return undefined;
};

export interface Parser {
  prepare(data: string): any;
  subs(obj: any, subs: Subscriptions[]): boolean;
  fill(obj: any, getObject: GetObject): boolean;
}

export const createParser = (containerState: ContainerState, doc: Document): Parser => {
  const fillMap = new Map<any, Serializer<any>>();
  const subsMap = new Map<any, Serializer<any>>();

  return {
    prepare(data: string) {
      const serializer = getSerializer(data);
      if (serializer) {
        const value = serializer.$prepare$(data.slice(1), containerState, doc);
        if (serializer.$fill$) {
          fillMap.set(value, serializer);
        }
        if (serializer.$subs$) {
          subsMap.set(value, serializer);
        }
        return value;
      }
      return data;
    },
    subs(obj: any, subs: Subscriptions[]) {
      const serializer = subsMap.get(obj);
      if (serializer) {
        serializer.$subs$!(obj, subs, containerState);
        return true;
      }
      return false;
    },
    fill(obj: any, getObject: GetObject) {
      const serializer = fillMap.get(obj);
      if (serializer) {
        serializer.$fill$!(obj, getObject, containerState);
        return true;
      }
      return false;
    },
  };
};

export const OBJECT_TRANSFORMS: Record<string, (obj: any, containerState: ContainerState) => any> =
  {
    '!': (obj: any, containerState: ContainerState) => {
      return containerState.$proxyMap$.get(obj) ?? getOrCreateProxy(obj, containerState);
    },
    '~': (obj: any) => {
      return Promise.resolve(obj);
    },
    _: (obj: any) => {
      return Promise.reject(obj);
    },
  };

const isTreeShakeable = (
  manager: SubscriptionManager,
  target: LocalSubscriptionManager,
  leaks: QwikElement | boolean
) => {
  if (typeof leaks === 'boolean') {
    return leaks;
  }
  const localManager = manager.$groupToManagers$.get(leaks);
  if (localManager && localManager.length > 0) {
    if (localManager.length === 1) {
      return localManager[0] !== target;
    }
    return true;
  }
  return false;
};

const getResolveJSXType = (type: any) => {
  if (type === ':slot') {
    return Slot;
  }
  if (type === ':fragment') {
    return Fragment;
  }
  return type;
};
