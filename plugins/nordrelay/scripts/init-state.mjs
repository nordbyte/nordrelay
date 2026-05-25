import fs from "node:fs";
import path from "node:path";

export function printExistingInitState(home, envPath) {
  const state = readExistingInitState(home);
  console.log(`Config already exists: ${envPath}`);
  console.log(`User store: ${state.usersPath}`);
  if (!state.userStoreExists) {
    console.log("Admin user: missing (users.json does not exist yet)");
    console.log("Run `nordrelay user create-admin` to finish setup, or rerun `nordrelay init --force` to overwrite the config.");
    return;
  }
  if (state.readError) {
    console.log(`Admin user: unknown (${state.readError})`);
    console.log("Run `nordrelay doctor` to inspect the setup, or rerun `nordrelay init --force` to overwrite the config.");
    return;
  }
  console.log(state.adminConfigured ? "Admin user: configured" : `Admin user: missing (${state.userCount} user${state.userCount === 1 ? "" : "s"} found)`);
  if (state.adminConfigured) {
    console.log("Run `nordrelay doctor` to validate the setup, or rerun `nordrelay init --force` to overwrite the config.");
  } else {
    console.log("Run `nordrelay user create-admin` to finish setup, or rerun `nordrelay init --force` to overwrite the config.");
  }
}

function readExistingInitState(home) {
  const usersPath = path.join(home, "users.json");
  if (!fs.existsSync(usersPath)) {
    return { usersPath, userStoreExists: false, userCount: 0, adminConfigured: false, readError: "" };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(usersPath, "utf8"));
    const users = Array.isArray(payload?.users) ? payload.users : [];
    const userGroups = Array.isArray(payload?.userGroups) ? payload.userGroups : [];
    const adminConfigured = users.some((user) =>
      user &&
      user.active !== false &&
      userGroups.some((group) => group?.userId === user.id && group?.groupId === "admin")
    );
    return { usersPath, userStoreExists: true, userCount: users.length, adminConfigured, readError: "" };
  } catch (error) {
    return { usersPath, userStoreExists: true, userCount: 0, adminConfigured: false, readError: error instanceof Error ? error.message : String(error) };
  }
}
