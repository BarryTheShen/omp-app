import { expect, test } from "bun:test";
import {
  type AccountFacts,
  agentAccountProblem,
  denyAction,
  guardSettings,
  invokerUid,
  otherPerson,
  PATHS,
  personProblem,
  withAccount,
  withoutAccount,
} from "./plan";

test("the person is the account that asked through pkexec or sudo, never root, never one named in an argument (#20)", () => {
  expect(invokerUid({ PKEXEC_UID: "1000" })).toBe(1000);
  expect(invokerUid({ SUDO_UID: "1001" })).toBe(1001);
  expect(invokerUid({ PKEXEC_UID: "1000", SUDO_UID: "1000" })).toBe(1000);
  expect(invokerUid({ PKEXEC_UID: "1000", SUDO_UID: "1001" })).toContain("different accounts");
  expect(invokerUid({ PKEXEC_UID: "0" })).toContain("cannot be root");
  expect(invokerUid({ SUDO_UID: "1000x" })).toContain("could not be read");
  expect(invokerUid({})).toContain("Agent access panel");
});

test("only an administrator's login account may be the person: a turn-on may lead to a sudo grant (bundle audit F1)", () => {
  const alice: AccountFacts = {
    name: "alice",
    uid: 1000,
    home: "/home/alice",
    shell: "/bin/bash",
    groups: ["alice", "sudo"],
  };
  const facts = { uidMin: 1000, uidMax: 60000, shells: ["/bin/bash", "/bin/sh"], homeOwner: 1000 };
  expect(personProblem(alice, facts)).toBeNull();
  expect(personProblem({ ...alice, groups: ["alice", "admin"] }, facts)).toBeNull();
  expect(personProblem({ ...alice, groups: ["alice"] }, facts)).toContain("not an administrator");
  expect(personProblem({ ...alice, uid: 998 }, { ...facts, homeOwner: 998 })).toContain(
    "not a login account",
  );
  expect(personProblem({ ...alice, shell: "/usr/sbin/nologin" }, facts)).toContain(
    "no login shell",
  );
  expect(personProblem(alice, { ...facts, homeOwner: 1001 })).toContain("is not theirs");
  expect(personProblem({ ...alice, name: "omp-agent" }, facts)).toContain("cannot be the person");
});

test("an existing omp-agent is used and removed only when setup made it: system uid, its home, no other group (bundle audit F2)", () => {
  const agent: AccountFacts = {
    name: "omp-agent",
    uid: 990,
    home: PATHS.agentHome,
    shell: "/bin/sh",
    groups: ["omp-agent"],
  };
  expect(agentAccountProblem(agent, { uid: 990 }, 1000)).toBeNull();
  expect(agentAccountProblem(agent, null, 1000)).toContain("did not make");
  expect(agentAccountProblem(agent, { uid: 991 }, 1000)).toContain("did not make");
  expect(agentAccountProblem({ ...agent, uid: 1005 }, { uid: 1005 }, 1000)).toContain(
    "system account",
  );
  expect(agentAccountProblem({ ...agent, home: "/home/omp-agent" }, { uid: 990 }, 1000)).toContain(
    "system account",
  );
  expect(
    agentAccountProblem({ ...agent, groups: ["omp-agent", "docker"] }, { uid: 990 }, 1000),
  ).toContain("docker");
});

test("a computer set up for one person is not taken over by another, nor when its settings are unreadable (#20)", () => {
  const settings = JSON.stringify(guardSettings("alice", 1000, false));
  expect(otherPerson(null, 1001)).toBeNull();
  expect(otherPerson(settings, 1000)).toBeNull();
  expect(otherPerson(settings, 1001)).toBe("alice");
  expect(otherPerson("{not json", 1000)).toContain("do not name");
  expect(otherPerson(JSON.stringify({ person: "alice" }), 1000)).toContain("do not name");
});

test("the guard's settings point at the bundled OpenSSH, with OpenSSH 10's split programs only when present (#20)", () => {
  const older = guardSettings("alice", 1000, false);
  expect(older).toMatchObject({
    schema: 1,
    person: "alice",
    personUid: 1000,
    account: "omp-agent",
    sshd: `${PATHS.openssh}/usr/sbin/sshd`,
    sftpServer: `${PATHS.openssh}/usr/lib/openssh/sftp-server`,
    wrapper: `${PATHS.program} wrapper`,
  });
  expect(older).not.toHaveProperty("sshdSession");
  expect(guardSettings("alice", 1000, true)).toMatchObject({
    sshdSession: `${PATHS.openssh}/usr/lib/openssh/sshd-session`,
    sshdAuth: `${PATHS.openssh}/usr/lib/openssh/sshd-auth`,
  });
});

test("deny files keep who else may schedule jobs: an allow file is enough, at.deny is never created (bundle audit F5)", () => {
  expect(denyAction("cron", { allowExists: true, denyExists: true })).toBe("nothing");
  expect(denyAction("cron", { allowExists: false, denyExists: true })).toBe("append");
  expect(denyAction("cron", { allowExists: false, denyExists: false })).toBe("create");
  expect(denyAction("at", { allowExists: false, denyExists: false })).toBe("nothing");
  expect(denyAction("at", { allowExists: false, denyExists: true })).toBe("append");
  expect(withAccount("", "omp-agent")).toBe("omp-agent\n");
  expect(withAccount("bob", "omp-agent")).toBe("bob\nomp-agent\n");
  expect(withAccount("bob\nomp-agent\n", "omp-agent")).toBeNull();
  expect(withoutAccount("bob\nomp-agent\ncarol\n", "omp-agent")).toBe("bob\ncarol\n");
  expect(withoutAccount("omp-agent-old\n", "omp-agent")).toBeNull();
});
