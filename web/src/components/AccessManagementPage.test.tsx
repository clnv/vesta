import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Directory, PermissionCatalog, Session } from "../types";
import { AccessManagementPage } from "./AccessManagementPage";

const api = vi.hoisted(() => ({
  addDirectoryMembership: vi.fn(),
  createDirectoryTeam: vi.fn(),
  createDirectoryUser: vi.fn(),
  getDirectory: vi.fn(),
  getPermissionCatalog: vi.fn(),
  removeDirectoryMembership: vi.fn(),
  updateDirectoryTeam: vi.fn(),
  updateDirectoryUser: vi.fn(),
}));

vi.mock("../lib/api", () => api);

const session: Session = {
  user: {
    subject: "user-admin",
    email: "ada@example.test",
    name: "Ada Admin",
    isAdmin: true,
    teams: [{ id: "team-platform", name: "Platform" }],
  },
  sources: [],
  csrfToken: "csrf-token",
  limits: { queryTimeoutMs: 30_000, maxRows: 50_000, maxBytes: 32 << 20, maxQueries: 4 },
};

const directory: Directory = {
  users: [
    {
      id: "user-admin",
      email: "ada@example.test",
      name: "Ada Admin",
      roles: ["reader"],
      isAdmin: true,
      disabled: false,
      createdAt: "2026-07-20T00:00:00Z",
    },
    {
      id: "user-member",
      email: "grace@example.test",
      name: "Grace Member",
      roles: [],
      isAdmin: false,
      disabled: false,
      createdAt: "2026-07-21T00:00:00Z",
    },
  ],
  teams: [{ id: "team-platform", name: "Platform" }],
  memberships: [{ userId: "user-admin", teamId: "team-platform" }],
};

const catalog: PermissionCatalog = {
  roles: ["reader", "source-reader"],
  sources: [{
    id: "prod",
    name: "Production",
    roles: ["reader"],
  }],
};

const props = {
  session,
  theme: "light" as const,
  onTheme: vi.fn(),
  onBack: vi.fn(),
  onMessage: vi.fn(),
  onSessionChanged: vi.fn(async () => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getDirectory.mockResolvedValue(directory);
  api.getPermissionCatalog.mockResolvedValue(catalog);
  api.createDirectoryUser.mockResolvedValue(directory.users[1]);
  api.createDirectoryTeam.mockResolvedValue({ id: "team-new", name: "New team" });
  api.updateDirectoryUser.mockResolvedValue(directory.users[0]);
  api.updateDirectoryTeam.mockResolvedValue(directory.teams[0]);
  api.addDirectoryMembership.mockResolvedValue(undefined);
  api.removeDirectoryMembership.mockResolvedValue(undefined);
});

afterEach(cleanup);

it("guards the page before making admin requests", () => {
  render(<AccessManagementPage {...props} session={{ ...session, user: { ...session.user, isAdmin: false } }} />);

  expect(screen.getByRole("heading", { name: "Access denied" })).toBeInTheDocument();
  expect(api.getDirectory).not.toHaveBeenCalled();
  expect(api.getPermissionCatalog).not.toHaveBeenCalled();
});

it("loads the directory and explains configured permission grants", async () => {
  render(<AccessManagementPage {...props} />);

  expect(await screen.findByRole("heading", { name: "Users" })).toBeInTheDocument();
  expect(screen.getByText("Grace Member")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Permissions" }));

  expect(screen.getByRole("heading", { name: "Permissions" })).toBeInTheDocument();
  expect(screen.getByText("Production")).toBeInTheDocument();
  expect(screen.getByText("1", { selector: ".audit-number" })).toBeInTheDocument();
});

it("treats a source without roles as default deny", async () => {
  api.getPermissionCatalog.mockResolvedValue({
    ...catalog,
    sources: [{
      ...catalog.sources[0],
      roles: [],
    }],
  });

  render(<AccessManagementPage {...props} />);

  expect(await screen.findByRole("heading", { name: "Users" })).toBeInTheDocument();
  expect(screen.getByText("Access management")).toBeInTheDocument();
});

it("saves profile, roles, and memberships transactionally", async () => {
  render(<AccessManagementPage {...props} />);

  const name = await screen.findByDisplayValue("Ada Admin");
  fireEvent.change(name, { target: { value: "Ada Lovelace" } });
  fireEvent.click(screen.getByLabelText("source-reader"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(api.updateDirectoryUser).toHaveBeenCalledWith(
    "user-admin",
    {
      email: "ada@example.test",
      name: "Ada Lovelace",
      roles: ["reader", "source-reader"],
      isAdmin: true,
      disabled: false,
      teamIds: ["team-platform"],
    },
    "csrf-token",
  ));
  expect(props.onSessionChanged).toHaveBeenCalled();
  expect(props.onMessage).toHaveBeenCalledWith("User access updated");
});

it("creates users and manages team names and memberships", async () => {
  render(<AccessManagementPage {...props} />);
  await screen.findByRole("heading", { name: "Users" });

  fireEvent.click(screen.getByRole("button", { name: "Open create user form" }));
  const createForm = screen.getByRole("heading", { name: "Create user" }).closest("form");
  if (!createForm) throw new Error("create user form missing");
  const createView = within(createForm);
  fireEvent.change(createView.getByLabelText("Display name"), { target: { value: "New User" } });
  fireEvent.change(createView.getByLabelText("Email"), { target: { value: "new@example.test" } });
  fireEvent.change(createView.getByLabelText("Temporary password"), { target: { value: "temporary-password" } });
  fireEvent.click(createView.getByLabelText("reader"));
  fireEvent.click(createView.getByRole("button", { name: "Create user" }));
  await waitFor(() => expect(api.createDirectoryUser).toHaveBeenCalledWith({
    email: "new@example.test",
    name: "New User",
    password: "temporary-password",
    roles: ["reader"],
    isAdmin: false,
  }, "csrf-token"));

  fireEvent.click(screen.getByRole("tab", { name: "Teams" }));
  const teamName = await screen.findByDisplayValue("Platform");
  fireEvent.change(teamName, { target: { value: "Core platform" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(api.updateDirectoryTeam).toHaveBeenCalledWith("team-platform", "Core platform", "csrf-token"));

  fireEvent.click(screen.getByRole("button", { name: "Remove Ada Admin from Platform" }));
  await waitFor(() => expect(api.removeDirectoryMembership).toHaveBeenCalledWith("user-admin", "team-platform", "csrf-token"));
  expect(props.onSessionChanged).toHaveBeenCalled();
});

it("shows a recoverable load error", async () => {
  api.getDirectory.mockRejectedValueOnce(new Error("Directory unavailable"));
  render(<AccessManagementPage {...props} />);

  expect(await screen.findByRole("heading", { name: "Access management is unavailable" })).toBeInTheDocument();
  expect(screen.getByText("Directory unavailable")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
});
