// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { DataSourceFactoryInitializeArgs } from "@lichtblick/suite-base/context/PlayerSelectionContext";
import { FILE_ACCEPT_TYPE } from "@lichtblick/suite-base/context/Workspace/constants";
import { IterablePlayer } from "@lichtblick/suite-base/players/IterablePlayer";
import { WorkerSerializedIterableSource } from "@lichtblick/suite-base/players/IterablePlayer/WorkerSerializedIterableSource";
import { BasicBuilder } from "@lichtblick/test-builders";

import TurbodataLocalDataSourceFactory from "./TurbodataLocalDataSourceFactory";

const TURBODATA_LOCAL_FILE_ID = "turbodata-local-file";

// Worker mock to avoid real execution in tests
global.Worker = jest.fn().mockImplementation(() => ({
  postMessage: jest.fn(),
  terminate: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/players/IterablePlayer", () => ({
  IterablePlayer: jest.fn(),
}));

jest.mock("@lichtblick/suite-base/players/IterablePlayer/WorkerSerializedIterableSource", () => ({
  WorkerSerializedIterableSource: jest.fn(),
}));

describe("TurbodataLocalDataSourceFactory", () => {
  let factory: TurbodataLocalDataSourceFactory;

  beforeEach(() => {
    factory = new TurbodataLocalDataSourceFactory();
    jest.clearAllMocks();
  });

  function buildTurbodataFile(): File {
    return new File([BasicBuilder.string()], `${BasicBuilder.string()}.td`, {
      type: FILE_ACCEPT_TYPE,
    });
  }

  function setup({ file, files }: Pick<DataSourceFactoryInitializeArgs, "files" | "file">) {
    const args: DataSourceFactoryInitializeArgs = {
      file,
      files,
      metricsCollector: jest.fn(),
    } as unknown as DataSourceFactoryInitializeArgs;

    return {
      args,
    };
  }

  it("should create a IterablePlayer with one file", () => {
    const files = [buildTurbodataFile()];
    const { args } = setup({ files });

    const player = factory.initialize(args);

    expect(WorkerSerializedIterableSource).toHaveBeenCalledWith({
      initWorker: expect.any(Function),
      initArgs: { files },
    });
    expect(IterablePlayer).toHaveBeenCalledWith({
      metricsCollector: args.metricsCollector,
      source: expect.any(Object),
      name: files[0]!.name,
      sourceId: TURBODATA_LOCAL_FILE_ID,
      readAheadDuration: { sec: 120, nsec: 0 },
    });
    expect(player).toBeInstanceOf(IterablePlayer);
  });

  it("should create a IterablePlayer with multiple files", () => {
    const files = [buildTurbodataFile(), buildTurbodataFile()];
    const { args } = setup({ files });

    const player = factory.initialize(args);

    expect(WorkerSerializedIterableSource).toHaveBeenCalledWith({
      initWorker: expect.any(Function),
      initArgs: { files },
    });
    expect(IterablePlayer).toHaveBeenCalledWith({
      metricsCollector: args.metricsCollector,
      source: expect.any(Object),
      name: `${files[0]!.name}, ${files[1]!.name}`,
      sourceId: TURBODATA_LOCAL_FILE_ID,
      readAheadDuration: { sec: 120, nsec: 0 },
    });
    expect(player).toBeInstanceOf(IterablePlayer);
  });

  it("should return undefined when no files are provided", () => {
    const { args } = setup({ files: undefined });

    const player = factory.initialize(args);

    expect(player).toBeUndefined();
    expect(WorkerSerializedIterableSource).not.toHaveBeenCalled();
    expect(IterablePlayer).not.toHaveBeenCalled();
  });

  it("should handle one file", () => {
    const file = buildTurbodataFile();
    const { args } = setup({ file });

    const player = factory.initialize(args);

    expect(WorkerSerializedIterableSource).toHaveBeenCalledWith({
      initWorker: expect.any(Function),
      initArgs: { files: [file] },
    });
    expect(IterablePlayer).toHaveBeenCalledWith({
      metricsCollector: args.metricsCollector,
      source: expect.any(Object),
      name: file.name,
      sourceId: TURBODATA_LOCAL_FILE_ID,
      readAheadDuration: { sec: 120, nsec: 0 },
    });
    expect(player).toBeInstanceOf(IterablePlayer);
  });
});
