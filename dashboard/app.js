const $ = (selector) => document.querySelector(selector);

const ui = {
  connection: $("#connection"),
  connectionText: $("#connection-text"),
  notice: $("#notice"),
  noticeIcon: $("#notice-icon"),
  noticeText: $("#notice-text"),
  signInPanel: $("#sign-in-panel"),
  signInForm: $("#sign-in-form"),
  signInButton: $("#sign-in-button"),
  signInError: $("#sign-in-error"),
  signOut: $("#sign-out"),
  dashboard: $("#dashboard"),
  temperature: $("#temperature"),
  temperatureState: $("#temperature-state"),
  humidity: $("#humidity"),
  humidityState: $("#humidity-state"),
  mq135Raw: $("#mq135-raw"),
  signalBar: $("#signal-bar"),
  signalLabel: $("#signal-label"),
  lastUpdate: $("#last-update"),
  ledState: $("#led-state"),
  ledToggle: $("#led-toggle")
};

let auth;
let database;
let firebaseAuth;
let firebaseDatabase;
let ledOn = false;
let commandLoaded = false;
let writingCommand = false;
let stopTelemetry = null;
let stopCommand = null;
let currentUser = null;

function showNotice(message, kind = "info") {
  ui.noticeText.textContent = message;
  ui.notice.dataset.kind = kind;
  ui.noticeIcon.textContent = kind === "error" ? "!" : "i";
  ui.notice.classList.remove("hidden");
}

function hideNotice() {
  ui.notice.classList.add("hidden");
}

function setConnection(state, message) {
  ui.connection.dataset.state = state;
  ui.connectionText.textContent = message;
}

function showDemoPreview() {
  ui.signInPanel.classList.add("hidden");
  ui.dashboard.classList.remove("hidden");
  ui.signOut.classList.add("hidden");

  ui.temperature.textContent = "22.8";
  ui.humidity.textContent = "48.1";
  ui.temperatureState.textContent = "Sample data · not connected";
  ui.humidityState.textContent = "Sample data · not connected";
  ui.mq135Raw.textContent = "1270";
  ui.signalBar.style.width = `${1270 / 4095 * 100}%`;
  ui.signalLabel.textContent = "31% of ADC range · sample only";

  const sampleTime = new Date();
  ui.lastUpdate.dateTime = sampleTime.toISOString();
  ui.lastUpdate.textContent = `${sampleTime.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  })} · demo`;

  ui.ledToggle.setAttribute("aria-checked", "false");
  ui.ledToggle.disabled = true;
  ui.ledState.textContent = "Demo preview · control disabled";
  setConnection("demo", "Demo preview");
  showNotice("Demo data only — connect Firebase to see live sensor readings and control the LED.");
}

function setSignedIn(user) {
  currentUser = user;
  ui.signInPanel.classList.toggle("hidden", Boolean(user));
  ui.dashboard.classList.toggle("hidden", !user);
  ui.signOut.classList.toggle("hidden", !user);
  ui.signInError.textContent = "";
  if (!user) {
    ui.ledToggle.disabled = true;
    ui.ledState.textContent = "Waiting for device status";
    ui.lastUpdate.textContent = "Waiting for data";
    ui.lastUpdate.removeAttribute("datetime");
    ui.temperature.textContent = "--";
    ui.humidity.textContent = "--";
    ui.mq135Raw.textContent = "--";
    ui.temperatureState.textContent = "Waiting for a valid DHT22 sample";
    ui.humidityState.textContent = "Waiting for a valid DHT22 sample";
    ui.signalLabel.textContent = "Relative sensor signal · not calibrated";
    ui.signalBar.style.width = "0%";
    if (stopTelemetry) stopTelemetry();
    if (stopCommand) stopCommand();
    stopTelemetry = null;
    stopCommand = null;
    setConnection("disconnected", "Signed out");
    return;
  }
  setConnection("connected", "Signed in");
  startRealtimeListeners();
}

function formatNumber(value, digits = 1) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "--";
}

function updateTelemetry(snapshot) {
  if (!snapshot.exists()) {
    showNotice("No telemetry has been published yet. Check that the ESP32 is powered on and connected to Firebase.");
    ui.lastUpdate.textContent = "No sample yet";
    return;
  }

  const data = snapshot.val();
  if (!data || typeof data !== "object") {
    showNotice("Firebase returned an unexpected telemetry value.", "error");
    return;
  }

  if (ui.notice.dataset.kind !== "error") hideNotice();
  if (data.dhtValid !== false &&
      typeof data.temperature === "number" && Number.isFinite(data.temperature) &&
      typeof data.humidity === "number" && Number.isFinite(data.humidity)) {
    ui.temperature.textContent = formatNumber(data.temperature);
    ui.humidity.textContent = formatNumber(data.humidity);
    ui.temperatureState.textContent = "DHT22 · latest sample valid";
    ui.humidityState.textContent = "DHT22 · latest sample valid";
  } else {
    ui.temperature.textContent = "--";
    ui.humidity.textContent = "--";
    ui.temperatureState.textContent = "DHT22 sample unavailable";
    ui.humidityState.textContent = "DHT22 sample unavailable";
  }

  const raw = data.gas;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    const boundedRaw = Math.min(4095, raw);
    ui.mq135Raw.textContent = String(Math.round(raw));
    ui.signalBar.style.width = `${boundedRaw / 4095 * 100}%`;
    ui.signalLabel.textContent = `${Math.round(boundedRaw / 4095 * 100)}% of ADC range · relative, not calibrated`;
  } else {
    ui.mq135Raw.textContent = "--";
    ui.signalBar.style.width = "0%";
    ui.signalLabel.textContent = "Waiting for MQ-135 sample";
  }

  const updatedAt = data.updatedAt;
  const timestampMs = updatedAt * 1000;
  if (typeof updatedAt === "number" &&
      Number.isFinite(timestampMs) &&
      updatedAt > 0 &&
      !Number.isNaN(new Date(timestampMs).getTime())) {
    const timestamp = new Date(timestampMs);
    ui.lastUpdate.dateTime = timestamp.toISOString();
    ui.lastUpdate.textContent = timestamp.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } else {
    ui.lastUpdate.textContent = "Time not synchronized";
    ui.lastUpdate.removeAttribute("datetime");
  }
}

function updateCommand(snapshot) {
  commandLoaded = true;
  ledOn = snapshot.exists() && (snapshot.val() === "1" || snapshot.val() === true);
  ui.ledToggle.setAttribute("aria-checked", String(ledOn));
  ui.ledToggle.disabled = writingCommand;
  ui.ledState.textContent = ledOn ? "LED is on" : "LED is off";
}

function startRealtimeListeners() {
  if (stopTelemetry) stopTelemetry();
  if (stopCommand) stopCommand();
  commandLoaded = false;
  ui.ledToggle.disabled = true;
  ui.ledState.textContent = "Loading device status…";

  stopTelemetry = firebaseDatabase.onValue(
    firebaseDatabase.ref(database, "FirebaseIOT"),
    updateTelemetry,
    (error) => {
      setConnection("error", "Database error");
      showNotice(`Could not read sensor data: ${error.message}`, "error");
    }
  );

  stopCommand = firebaseDatabase.onValue(
    firebaseDatabase.ref(database, "FirebaseIOT/led"),
    updateCommand,
    (error) => {
      ui.ledToggle.disabled = true;
      setConnection("error", "Database error");
      showNotice(`Could not read the LED command: ${error.message}`, "error");
    }
  );
}

async function initializeFirebase() {
  try {
    let configModule;
    try {
      configModule = await import("./firebase-config.js");
    } catch {
      throw new Error("Firebase config is missing. Copy firebase-config.example.js to firebase-config.js and fill in your Firebase Web app values.");
    }
    const { firebaseConfig } = configModule;
    const requiredFields = ["apiKey", "authDomain", "databaseURL", "projectId", "appId"];
    const invalidConfig = !firebaseConfig || requiredFields.some((field) => {
      const value = firebaseConfig[field];
      return typeof value !== "string" || !value || value.startsWith("YOUR_");
    });
    if (invalidConfig) {
      throw new Error("Firebase config is incomplete. Copy firebase-config.example.js to firebase-config.js and fill in your Firebase Web app values.");
    }

    const [appSdk, authSdk, databaseSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js")
    ]);

    const app = appSdk.initializeApp(firebaseConfig);
    firebaseAuth = authSdk;
    firebaseDatabase = databaseSdk;
    database = databaseSdk.getDatabase(app);
    auth = authSdk.getAuth(app);

    authSdk.onAuthStateChanged(auth, (user) => {
      setSignedIn(user);
      if (user) hideNotice();
    }, (error) => {
      setConnection("error", "Authentication error");
      showNotice(`Firebase authentication error: ${error.message}`, "error");
    });
    setConnection("disconnected", "Sign in required");
    ui.signInPanel.classList.remove("hidden");
    hideNotice();
  } catch (error) {
    setConnection("error", "Configuration needed");
    showNotice(error.message || "Firebase could not be initialized.", "error");
  }
}

ui.signInForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!auth || currentUser) return;
  const email = $("#email").value.trim();
  const password = $("#password").value;
  ui.signInButton.disabled = true;
  ui.signInButton.textContent = "Signing in…";
  ui.signInError.textContent = "";
  try {
    await firebaseAuth.signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    ui.signInError.textContent = error.message;
  } finally {
    ui.signInButton.disabled = false;
    ui.signInButton.textContent = "Sign in";
  }
});

ui.signOut.addEventListener("click", async () => {
  try {
    await firebaseAuth.signOut(auth);
  } catch (error) {
    showNotice(`Could not sign out: ${error.message}`, "error");
  }
});

ui.ledToggle.addEventListener("click", async () => {
  if (!auth?.currentUser || !commandLoaded || writingCommand) return;
  writingCommand = true;
  ui.ledToggle.disabled = true;
  ui.ledState.textContent = "Sending command…";
  try {
    await firebaseDatabase.set(
      firebaseDatabase.ref(database, "FirebaseIOT/led"),
      ledOn ? "0" : "1"
    );
  } catch (error) {
    ui.ledState.textContent = ledOn ? "LED is on" : "LED is off";
    showNotice(`Could not update the LED command: ${error.message}`, "error");
  } finally {
    writingCommand = false;
    ui.ledToggle.disabled = !commandLoaded;
  }
});

if (new URLSearchParams(window.location.search).get("demo") === "1") {
  showDemoPreview();
} else {
  initializeFirebase();
}
