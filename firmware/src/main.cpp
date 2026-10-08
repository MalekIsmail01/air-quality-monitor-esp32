#define ENABLE_USER_AUTH
#define ENABLE_DATABASE

#include <Arduino.h>
#include <DHT.h>
#include <FirebaseClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <cstring>
#include <time.h>

#include "firebase_root_ca.h"

#if __has_include("secrets.h")
#include "secrets.h"
#else
#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define FIREBASE_API_KEY ""
#define FIREBASE_DATABASE_URL ""
#define FIREBASE_USER_EMAIL ""
#define FIREBASE_USER_PASSWORD ""
#endif

namespace {
constexpr uint8_t DHT_PIN = 4;
constexpr uint8_t MQ135_PIN = 34;
constexpr uint8_t LED_PIN = 25;
constexpr uint32_t SENSOR_INTERVAL_MS = 2500;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 5000;
constexpr uint32_t COMMAND_INTERVAL_MS = 2000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 10000;
constexpr char TELEMETRY_PATH[] = "/FirebaseIOT";
constexpr char LED_COMMAND_PATH[] = "/FirebaseIOT/led";

DHT dht(DHT_PIN, DHT22);
UserAuth userAuth(FIREBASE_API_KEY, FIREBASE_USER_EMAIL, FIREBASE_USER_PASSWORD);
FirebaseApp firebaseApp;
WiFiClientSecure sslClient;
using AsyncClient = AsyncClientClass;
AsyncClient firebaseClient(sslClient);
RealtimeDatabase realtimeDatabase;

uint32_t lastSensorAt = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastCommandAt = 0;
uint32_t lastWifiAttemptAt = 0;
float temperatureC = 0.0f;
float humidityPercent = 0.0f;
uint16_t mq135Raw = 0;
bool dhtValid = false;
bool ledOn = false;
bool wifiAttempted = false;
bool firebaseInitialized = false;
bool clockSyncStarted = false;

bool credentialsConfigured() {
  return strlen(WIFI_SSID) > 0 &&
         strlen(WIFI_PASSWORD) > 0 &&
         strlen(FIREBASE_API_KEY) > 0 &&
         strlen(FIREBASE_DATABASE_URL) > 0 &&
         strlen(FIREBASE_USER_EMAIL) > 0 &&
         strlen(FIREBASE_USER_PASSWORD) > 0;
}

void applyLed(bool on) {
  ledOn = on;
  digitalWrite(LED_PIN, ledOn ? HIGH : LOW);
}

void connectWifi() {
  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED ||
      (wifiAttempted && now - lastWifiAttemptAt < WIFI_RETRY_INTERVAL_MS)) {
    return;
  }

  lastWifiAttemptAt = now;
  wifiAttempted = true;
  Serial.println("Connecting to configured Wi-Fi network...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void sampleSensors() {
  const uint32_t now = millis();
  if (now - lastSensorAt < SENSOR_INTERVAL_MS) {
    return;
  }
  lastSensorAt = now;

  const float newHumidity = dht.readHumidity();
  const float newTemperature = dht.readTemperature();
  dhtValid = !isnan(newHumidity) && !isnan(newTemperature);
  if (dhtValid) {
    humidityPercent = newHumidity;
    temperatureC = newTemperature;
  } else {
    Serial.println("DHT22 read failed; will retry at the next sample interval.");
  }

  mq135Raw = static_cast<uint16_t>(analogRead(MQ135_PIN));
  Serial.printf("DHT22: %s | MQ-135 ADC: %u\n",
                dhtValid ? "valid" : "unavailable",
                mq135Raw);
}

void processFirebaseResult(AsyncResult &result) {
  if (!result.isResult()) {
    return;
  }

  if (result.isError()) {
    Serial.printf("Firebase task '%s' failed: %s (code %d)\n",
                  result.uid().c_str(),
                  result.error().message().c_str(),
                  result.error().code());
    return;
  }

  if (!result.available() || result.uid() != "led-command") {
    return;
  }

  String command = result.c_str();
  command.trim();
  if (command == "null") {
    applyLed(false);
  } else {
    if (command.length() >= 2 &&
        command.charAt(0) == '"' &&
        command.charAt(command.length() - 1) == '"') {
      command = command.substring(1, command.length() - 1);
    }

    if (command == "0" || command == "1") {
      applyLed(command == "1");
    } else {
      Serial.printf("Ignoring invalid Firebase LED command: '%s'\n",
                    command.c_str());
      return;
    }
  }

  Serial.printf("Firebase LED command: %s\n", ledOn ? "ON" : "OFF");
}

void publishTelemetry() {
  object_t telemetry;
  JsonWriter writer;
  writer.create(telemetry, "temperature", temperatureC);
  writer.create(telemetry, "humidity", humidityPercent);
  writer.create(telemetry, "dhtValid", dhtValid);
  writer.create(telemetry, "gas", mq135Raw);
  const time_t now = time(nullptr);
  writer.create(telemetry, "updatedAt", now > 0 ? static_cast<int>(now) : 0);
  writer.create(telemetry, "uptimeMs", static_cast<double>(millis()));

  realtimeDatabase.update(
      firebaseClient, TELEMETRY_PATH, telemetry, processFirebaseResult, "telemetry");
}

void readLedCommand() {
  realtimeDatabase.get(
      firebaseClient, LED_COMMAND_PATH, processFirebaseResult, false, "led-command");
}

void initializeFirebase() {
  sslClient.setCACert(FIREBASE_ROOT_CA);
  initializeApp(
      firebaseClient, firebaseApp, getAuth(userAuth), processFirebaseResult, "firebase-auth");
  firebaseApp.getApp<RealtimeDatabase>(realtimeDatabase);
  realtimeDatabase.url(FIREBASE_DATABASE_URL);
  firebaseInitialized = true;
  Serial.println("Firebase authentication started.");
}

void runFirebaseTasks() {
  firebaseApp.loop();
  if (!firebaseApp.ready()) {
    return;
  }

  const uint32_t now = millis();
  if (now - lastCommandAt >= COMMAND_INTERVAL_MS) {
    lastCommandAt = now;
    readLedCommand();
  }
  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    publishTelemetry();
  }
}
}  // namespace

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  applyLed(false);

  analogReadResolution(12);
  analogSetPinAttenuation(MQ135_PIN, ADC_11db);
  dht.begin();

  if (!credentialsConfigured()) {
    Serial.println("Missing configuration. Copy firmware/include/secrets.example.h");
    Serial.println("to firmware/include/secrets.h and fill in all values.");
    return;
  }

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  connectWifi();
  Serial.println("Air monitor started; LED is OFF until a valid remote command is read.");
}

void loop() {
  if (!credentialsConfigured()) {
    delay(1000);
    return;
  }

  connectWifi();
  sampleSensors();

  if (WiFi.status() == WL_CONNECTED && !clockSyncStarted) {
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    clockSyncStarted = true;
  }
  if (WiFi.status() == WL_CONNECTED &&
      !firebaseInitialized &&
      time(nullptr) > 1700000000) {
    initializeFirebase();
  }
  if (firebaseInitialized) {
    runFirebaseTasks();
  }

  delay(10);
}
