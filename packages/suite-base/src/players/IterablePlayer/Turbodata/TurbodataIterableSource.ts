// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  BlobReadSource,
  HttpRangeReadSource,
  Reader,
  type ReadSource,
  type Summary,
} from "turbodata";

import { ParsedChannel, parseChannel } from "@lichtblick/mcap-support";
import { Time, compare, fromNanoSec, toNanoSec } from "@lichtblick/rostime";
import { MessageEvent } from "@lichtblick/suite";
import {
  GetBackfillMessagesArgs,
  Initialization,
  ISerializedIterableSource,
  IteratorResult,
  MessageIteratorArgs,
  TopicWithDecodingInfo,
} from "@lichtblick/suite-base/players/IterablePlayer/IIterableSource";
import { PlayerAlert, TopicStats } from "@lichtblick/suite-base/players/types";
import { RosDatatypes } from "@lichtblick/suite-base/types/RosDatatypes";

export type TurbodataSource =
  | { type: "file"; file: Blob }
  | { type: "url"; url: string; cacheSizeInBytes?: number };

/**
 * Metadata keys written by the turbodata `mcap_to_td` converter. Each topic in a
 * group carries the schema for that group so the reader can recover it from any
 * topic. See turbodata/go/examples/mcap_to_td/main.go.
 */
const SCHEMA_NAME_KEY = "schema_name";
const SCHEMA_ENCODING_KEY = "schema_encoding";
const SCHEMA_DATA_KEY = "schema_data";
const MESSAGE_ENCODING_KEY = "message_encoding";

/**
 * Derive the MCAP "message encoding" from the "schema encoding" stored in the
 * turbodata metadata. The turbodata format only persists schema information, so
 * we map it onto the message encoding that `parseChannel` expects.
 *
 * See https://github.com/foxglove/mcap/blob/main/docs/specification/well-known-message-encodings.md
 */
function messageEncodingFromSchemaEncoding(schemaEncoding: string | undefined): string | undefined {
  switch (schemaEncoding) {
    case "ros1msg":
      return "ros1";
    case "ros2msg":
    case "ros2idl":
    case "omgidl":
      return "cdr";
    case "protobuf":
      return "protobuf";
    case "jsonschema":
      return "json";
    case "flatbuffer":
      return "flatbuffer";
    default:
      return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return undefined;
}

export class TurbodataIterableSource implements ISerializedIterableSource {
  #source: TurbodataSource;
  #reader?: Reader;
  #schemaNameByTopic = new Map<string, string | undefined>();
  #start?: Time;
  #end?: Time;

  public readonly sourceType = "serialized";

  public constructor(source: TurbodataSource) {
    this.#source = source;
  }

  #createReadSource(): ReadSource {
    switch (this.#source.type) {
      case "file":
        return new BlobReadSource(this.#source.file);
      case "url":
        return new HttpRangeReadSource(this.#source.url);
    }
  }

  public async initialize(): Promise<Initialization> {
    const reader = new Reader(this.#createReadSource());
    this.#reader = reader;

    const summary = await reader.summary();

    const topicsByName = new Map<string, TopicWithDecodingInfo>();
    const topicStats = new Map<string, TopicStats>();
    const datatypes: RosDatatypes = new Map();
    const alerts: PlayerAlert[] = [];
    const publishersByTopic = new Map<string, Set<string>>();

    const { startTime, endTime } = this.#computeTimeRange(summary);

    for (const topicsInfo of summary.topicsInfos) {
      for (const topicMetadata of topicsInfo.topicMetadatas) {
        const { name, metadata } = topicMetadata;
        if (topicsByName.has(name)) {
          continue;
        }

        const schemaName = asString(metadata.get(SCHEMA_NAME_KEY));
        const schemaEncoding = asString(metadata.get(SCHEMA_ENCODING_KEY));
        const schemaData = asUint8Array(metadata.get(SCHEMA_DATA_KEY));
        const messageEncoding =
          asString(metadata.get(MESSAGE_ENCODING_KEY)) ??
          messageEncodingFromSchemaEncoding(schemaEncoding);

        const topic: TopicWithDecodingInfo = {
          name,
          schemaName,
          messageEncoding,
          schemaEncoding,
          schemaData,
        };
        topicsByName.set(name, topic);
        topicStats.set(name, { numMessages: topicMetadata.messageCount });

        if (messageEncoding != undefined) {
          try {
            const parsedChannel: ParsedChannel = parseChannel({
              messageEncoding,
              schema:
                schemaName != undefined && schemaEncoding != undefined && schemaData != undefined
                  ? { name: schemaName, encoding: schemaEncoding, data: schemaData }
                  : undefined,
            });
            for (const [datatypeName, datatype] of parsedChannel.datatypes) {
              datatypes.set(datatypeName, datatype);
            }
          } catch (error) {
            alerts.push({
              severity: "error",
              message: `Error in topic ${name}: ${error.message}`,
              error,
            });
          }
        } else {
          alerts.push({
            severity: "warn",
            message: `Topic "${name}" has no known message encoding`,
            tip: `The turbodata file does not specify a message encoding for "${name}". Messages on this topic cannot be decoded.`,
          });
        }

        this.#schemaNameByTopic.set(name, schemaName);
      }
    }

    this.#start = fromNanoSec(startTime);
    this.#end = fromNanoSec(endTime);

    return {
      start: this.#start,
      end: this.#end,
      topics: [...topicsByName.values()],
      topicStats,
      datatypes,
      profile: undefined,
      alerts,
      publishersByTopic,
    };
  }

  #computeTimeRange(summary: Summary): { startTime: bigint; endTime: bigint } {
    let startTime: bigint | undefined;
    let endTime: bigint | undefined;
    for (const topicsInfo of summary.topicsInfos) {
      for (const info of topicsInfo.indexChunkInfoList) {
        if (startTime == undefined || info.startTimestamp < startTime) {
          startTime = info.startTimestamp;
        }
        if (endTime == undefined || info.endTimestamp > endTime) {
          endTime = info.endTimestamp;
        }
      }
    }
    return { startTime: startTime ?? 0n, endTime: endTime ?? startTime ?? 0n };
  }

  public async *messageIterator(
    args: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult<Uint8Array>>> {
    const reader = this.#reader;
    if (!reader) {
      throw new Error("Invariant: TurbodataIterableSource is not initialized");
    }

    const topics = args.topics;
    const start = args.start ?? this.#start;
    const end = args.end ?? this.#end;

    if (topics.size === 0 || !start || !end) {
      return;
    }

    const topicNames = Array.from(topics.keys());

    for await (const message of reader.readMessages({
      topicNames,
      startTimestamp: toNanoSec(start),
      endTimestamp: toNanoSec(end),
      copy: true,
    })) {
      const receiveTime = fromNanoSec(message.timestamp);
      yield {
        type: "message-event",
        msgEvent: {
          topic: message.topicName,
          receiveTime,
          publishTime: receiveTime,
          message: message.data,
          sizeInBytes: message.data.byteLength,
          schemaName: this.#schemaNameByTopic.get(message.topicName) ?? "",
        },
      };
    }
  }

  public async getBackfillMessages(
    args: GetBackfillMessagesArgs,
  ): Promise<MessageEvent<Uint8Array>[]> {
    const reader = this.#reader;
    if (!reader) {
      throw new Error("Invariant: TurbodataIterableSource is not initialized");
    }

    const { topics, time } = args;
    const messages: MessageEvent<Uint8Array>[] = [];

    for (const topic of topics.keys()) {
      // A separate reverse iterator per topic finds the latest message at or before `time`
      // without scanning unrelated topics.
      for await (const message of reader.readMessages({
        topicNames: [topic],
        endTimestamp: toNanoSec(time),
        order: "reverse-time",
        copy: true,
      })) {
        const receiveTime = fromNanoSec(message.timestamp);
        messages.push({
          topic: message.topicName,
          receiveTime,
          publishTime: receiveTime,
          message: message.data,
          sizeInBytes: message.data.byteLength,
          schemaName: this.#schemaNameByTopic.get(message.topicName) ?? "",
        });
        break;
      }
    }

    messages.sort((a, b) => compare(a.receiveTime, b.receiveTime));
    return messages;
  }

  public getStart(): Time | undefined {
    return this.#start;
  }

  public getEnd(): Time | undefined {
    return this.#end;
  }
}
