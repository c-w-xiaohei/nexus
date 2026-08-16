import type {
  IframeAdapterModel,
  IframeChildConnectionTarget,
  IframeParentConnectionTarget,
} from "./types.js";

const parentTarget: IframeParentConnectionTarget = {
  context: "iframe-parent",
  appId: "app",
  origin: "https://parent.test",
};
const childTarget: IframeChildConnectionTarget = {
  context: "iframe-child",
  frameId: "main",
};

void (parentTarget satisfies IframeAdapterModel["connectionTarget"]);
void (childTarget satisfies IframeAdapterModel["connectionTarget"]);

// Targets are immutable contracts once created.
// @ts-expect-error connection target fields are readonly.
parentTarget.appId = "other";

// A parent-to-child target cannot identify a configured frame without frameId.
// @ts-expect-error frameId is required for parent-to-child connection targets.
const missingFrameId: IframeChildConnectionTarget = {
  context: "iframe-child",
};

void missingFrameId;
