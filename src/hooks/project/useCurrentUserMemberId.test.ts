import { describe, expect, it } from "vitest";

import type { IUserInfo } from "@src/types/core/user";

import {
  findMemberIdsByUser,
  resolveCurrentUserIdentity,
} from "./useCurrentUserMemberId";

function user(overrides: Partial<IUserInfo> = {}): IUserInfo {
  return {
    uuid: "",
    name: "",
    authing_id: "",
    profile: "",
    picture: "",
    profile_image_url: "",
    openai_api_key: "",
    deepseek_api_key: "",
    git_user_name: "",
    git_user_email: "",
    github_infos: [],
    gitlab_infos: [],
    ...overrides,
  };
}

describe("current Work Item identity", () => {
  it("uses the project member identity for a consistent name and avatar", () => {
    const members = [
      {
        id: "user-ea821852",
        name: "hanafish",
        email: "hanafish@example.com",
        avatar: "https://example.com/hanafish.png",
        color: "#1677ff",
      },
    ];
    const account = user({
      uuid: "user-ea821852",
      name: "Account fallback",
      git_user_email: "hanafish@example.com",
    });
    const memberIds = findMemberIdsByUser(members, account);

    expect(
      resolveCurrentUserIdentity(members, memberIds, account, null)
    ).toEqual({
      id: "user-ea821852",
      name: "hanafish",
      email: "hanafish@example.com",
      avatar: "https://example.com/hanafish.png",
      color: "#1677ff",
    });
  });

  it("falls back to the signed-in profile instead of the generic You label", () => {
    const account = user({
      uuid: "user-ea821852",
      name: "hanafish",
      profile_image_url: "https://example.com/hanafish.png",
    });

    expect(
      resolveCurrentUserIdentity([], new Set(), account, null)
    ).toMatchObject({
      id: "user-ea821852",
      name: "hanafish",
      avatar: "https://example.com/hanafish.png",
    });
  });

  it("enriches an opaque member record with the signed-in profile", () => {
    const account = user({
      uuid: "user-ea821852",
      name: "Yuki",
      profile_image_url: "https://example.com/yuki.png",
    });

    expect(
      resolveCurrentUserIdentity(
        [{ id: "user-ea821852", name: "user-ea821852" }],
        new Set(),
        account,
        null
      )
    ).toMatchObject({
      id: "user-ea821852",
      name: "Yuki",
      avatar: "https://example.com/yuki.png",
    });
  });

  it("returns no actor when neither account nor git identity is trustworthy", () => {
    expect(resolveCurrentUserIdentity([], new Set(), user(), null)).toBeNull();
  });

  it("does not merge different people who share an email local-part", () => {
    const members = [
      {
        id: "member-company-alice",
        name: "Alice Company",
        email: "alice@company.example",
      },
      {
        id: "member-personal-alice",
        name: "Alice Personal",
        email: "alice@personal.example",
      },
    ];

    expect(
      findMemberIdsByUser(
        members,
        user({ git_user_email: "alice@company.example" })
      )
    ).toEqual(new Set(["member-company-alice"]));
  });

  it("does not infer a member id from a non-unique display name", () => {
    const members = [
      {
        id: "member-1",
        name: "Alex",
        email: "alex-one@example.com",
      },
      {
        id: "member-2",
        name: "Alex",
        email: "alex-two@example.com",
      },
    ];

    expect(findMemberIdsByUser(members, user({ name: "Alex" }))).toEqual(
      new Set()
    );
  });

  it("matches exact account ids and verified linked emails", () => {
    const members = [
      {
        id: "account-1",
        name: "Account member",
      },
      {
        id: "member-linked",
        name: "Linked member",
        linked_emails: [{ email: "linked@example.com" }],
      },
    ];

    expect(
      findMemberIdsByUser(
        members,
        user({
          uuid: "account-1",
          git_user_email: "linked@example.com",
        })
      )
    ).toEqual(new Set(["account-1", "member-linked"]));
  });
});
