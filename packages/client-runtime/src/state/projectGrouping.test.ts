import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { deriveProjectGroupLabel } from "./projectGrouping.ts";

function project(title: string): Pick<EnvironmentProject, "title" | "repositoryIdentity"> {
  return {
    title,
    repositoryIdentity: {
      canonicalKey: "git-remote:github.com/t3tools/t3code",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/t3tools/t3code.git",
      },
      displayName: "t3tools/t3code",
      name: "t3code",
    },
  };
}

describe("deriveProjectGroupLabel", () => {
  it("prefers a shared title over repository identity names", () => {
    const members = [project("My Project"), project("My Project")];

    expect(deriveProjectGroupLabel({ representative: members[0]!, members })).toBe("My Project");
  });

  it("uses the shared repository display name when titles differ", () => {
    const members = [project("Local Clone"), project("Remote Project")];

    expect(deriveProjectGroupLabel({ representative: members[0]!, members })).toBe(
      "t3tools/t3code",
    );
  });
});
