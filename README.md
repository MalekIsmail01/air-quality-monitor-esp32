# ESP32 Indoor Air Monitor

An ESP32-based indoor monitoring project for temperature, humidity, and the relative analog signal from an MQ-135 module. Sensor readings are published to Firebase Realtime Database, and a dashboard can remotely switch an LED connected to the ESP32.

> **Measurement note:** The MQ-135 output in this project is an uncalibrated ADC reading and a percentage of the ESP32 ADC range. It is not a calibrated gas concentration, scientific air-quality index, or safety alarm.

## Contents

- `firmware/` — PlatformIO project for an ESP32 DevKit-style board.
- `dashboard/` — Mobile-friendly static web app using Firebase Authentication and Realtime Database.

## Hardware and wiring

| Component | Connection |
| --- | --- |
| DHT22 VCC | ESP32 3V3 |
| DHT22 GND | ESP32 GND |
| DHT22 DATA | GPIO 4 |
| MQ-135 module VCC | 5V / VIN, subject to the module's specification |
| MQ-135 module GND | ESP32 GND (common ground is required) |
| MQ-135 analog output (AO) | Through a voltage divider to GPIO 34 |
| LED anode | GPIO 25 through a 220–330 ohm resistor |
| LED cathode | ESP32 GND |

The firmware uses GPIO 34 for the MQ-135 analog input because it is an input-only ADC pin on the classic ESP32, and GPIO 25 for an external LED. Verify pin names against your specific board.

**Protect the ESP32 input.** Many MQ-135 breakout boards are powered from 5 V and their analog output can rise close to 5 V. ESP32 GPIOs are not 5 V tolerant. Place a divider between AO and GPIO 34: connect a **10 kΩ resistor from AO to GPIO 34**, and a **15 kΩ resistor from GPIO 34 to GND**. This scales a 5 V signal to about 3.0 V. Keep a common ground and confirm the divider voltage with a meter before connecting it. Do not connect a 5 V analog output directly to the ESP32.

Some DHT22 sensors are bare sensors rather than breakout boards. A bare sensor generally needs a 4.7–10 kΩ pull-up from DATA to 3V3; many modules already include one.

## Firebase setup

1. Create a Firebase project and a **Realtime Database**. Choose the database region closest to the device and dashboard users.
2. In **Authentication → Sign-in method**, enable **Email/Password**. Create a dedicated account for this monitor. The firmware and the dashboard must sign in with an account allowed by your database rules.
3. In **Project settings → General**, register a Web app and note its Firebase configuration. The web API key is a public project identifier; do not put a service-account key or database secret in either client.
4. In the Realtime Database Rules editor, start with the following authenticated-only rules:

   ```json
   {
     "rules": {
       ".read": false,
       ".write": false,
       "FirebaseIOT": {
         ".read": "auth != null",
         ".write": "auth != null",
         "led": {
           ".validate": "newData.isString() && (newData.val() == '0' || newData.val() == '1')"
         }
       }
     }
   }
   ```

   These rules allow any signed-in Firebase user in this project to read and write the monitor data. Keep project membership and account creation restricted to trusted users; do not enable unauthenticated access. For a shared or public deployment, replace these broad authenticated rules with a stronger per-device authorization design.

5. Copy `dashboard/firebase-config.example.js` to `dashboard/firebase-config.js` and fill in the Web app configuration fields. The example file contains placeholders only; `firebase-config.js` is ignored by Git.
6. Copy `firmware/include/secrets.example.h` to `firmware/include/secrets.h`. Fill in Wi-Fi credentials, the Firebase Web API key and database URL, and the same Firebase Email/Password account. This local file is ignored by Git.

The firmware stores Wi-Fi and Firebase account credentials in its source before upload. Treat the device and its flash as sensitive, use a dedicated account, and never publish the local secrets file or a firmware binary built with real credentials. Firmware HTTPS requests verify server certificates against the public Google Trust Services GTS Root R1 certificate in `firmware/include/firebase_root_ca.h`; the firmware waits for network time before authenticating. Keep the root certificate current if it is rotated or before its June 2036 expiry.

### Database schema

The firmware updates telemetry at `/FirebaseIOT`:

```json
{
  "temperature": 23.4,
  "humidity": 45.2,
  "dhtValid": true,
  "gas": 1270,
  "updatedAt": 1730000000,
  "uptimeMs": 42000
}
```

The paths and legacy field names `temperature`, `humidity`, `gas`, and `led` match the report's example code and MIT App Inventor screen. `gas` contains the 12-bit MQ-135 ADC value, not a ppm value. `updatedAt` is a Unix timestamp in seconds and is `0` until the device has synchronized its clock. The firmware also sets `dhtValid` false when the latest DHT22 sample is invalid. It leaves the last numeric temperature and humidity values in place, but the dashboard labels them unavailable until a valid sample arrives.

The dashboard writes the report-compatible LED command as a string at `/FirebaseIOT/led`:

```json
{
  "led": "0"
}
```

## Build and upload firmware

1. Install [Visual Studio Code](https://code.visualstudio.com/) and the PlatformIO IDE extension, or install the PlatformIO Core CLI.
2. Create `firmware/include/secrets.h` from the example and fill its values.
3. Open the `firmware/` folder as the PlatformIO project.
4. Build with PlatformIO's **Build** action, or run `pio run` from `firmware/`.
5. Connect the ESP32 over USB, select the detected serial port, and upload with PlatformIO's **Upload** action, or run `pio run --target upload`.
6. Open the serial monitor at **115200 baud**. The device reports Wi-Fi, Firebase, and sensor errors there.

Firmware dependencies and the ESP32 platform version are pinned or constrained in `firmware/platformio.ini`. Firebase Realtime Database calls use the asynchronous FirebaseClient library so sensor sampling and retries continue while requests are processed.

## Run the dashboard

The dashboard is a static site, but it must be served over HTTP; opening `index.html` as a `file://` URL is not supported.

To preview the interface without configuring Firebase, open `http://localhost:8000/?demo=1` after starting the server. It displays clearly labeled sample values and disables the LED control; it does not connect to a device.

1. Copy and configure `dashboard/firebase-config.js` as described above.
2. From the repository root, start a local server:

   ```sh
   python -m http.server 8000 --directory dashboard
   ```

3. Open `http://localhost:8000` in a browser and sign in with the Firebase Email/Password account.
4. For deployment, serve the `dashboard/` directory over HTTPS from a static host (for example Firebase Hosting). Add the deployed hostname to the Firebase Authentication authorized domains. Configure the hosting tool to deploy only the dashboard assets and keep `firebase-config.js` out of source control.

The dashboard shows a connection/loading state, database errors, missing readings, the last-sample timestamp, and the latest temperature, humidity, and MQ-135 reading. The LED control is disabled until the current command has loaded; a failed write is displayed rather than silently treated as successful.

## Calibration, warm-up, and limitations

- MQ-135 sensors require a substantial initial preheat/burn-in period (often at least 24–48 hours, depending on the sensor and its datasheet) and time to warm up after each power-on. Follow the exact manufacturer datasheet for your sensor.
- This implementation reports the ESP32 ADC count and its fraction of ADC full scale. It does **not** estimate ppm, identify a specific gas, compare against health thresholds, or implement a standardized AQI.
- The raw signal depends on module circuitry, supply voltage, sensor age, temperature, humidity, ADC characteristics, and the divider. Reliable concentration estimates require a suitable calibration procedure, a known clean-air baseline and reference gases, sensor-specific parameters, and compensation. Do not interpret the displayed values as calibrated measurements.
- MQ-series sensors use a heated element and are not certified smoke, carbon-monoxide, combustible-gas, or life-safety detectors. Never use this project in place of a certified alarm or ventilation/safety system. Operate the sensor in a ventilated environment and follow its datasheet and local safety guidance.
- DHT22 values are sampled no faster than every 2.5 seconds. A failed read is reported with `dhtValid: false`; the firmware retries on the next sample interval.
- The LED defaults to OFF on boot and remains in its last safe local state if a Firebase command read fails. Remote control becomes active after Wi-Fi and Firebase authentication are ready.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Firmware says credentials are missing | Confirm `firmware/include/secrets.h` exists and that none of its values are placeholders. |
| Wi-Fi does not connect | Check SSID/password and use a 2.4 GHz network; ESP32 boards do not connect to 5 GHz-only Wi-Fi. |
| Firebase authentication/database errors | Check the API key, database URL (including `https://` and the correct regional hostname), Email/Password provider, account password, and authenticated-only rules. Check that device and dashboard use the same Firebase project. |
| Dashboard reports missing config | Copy `dashboard/firebase-config.example.js` to `dashboard/firebase-config.js`, fill it in, then reload the served page. |
| Dashboard cannot sign in | Verify the account, enabled Email/Password provider, and that `localhost` or the deployed hostname is an authorized Firebase Authentication domain. |
| Sensor reads are unavailable or unstable | Check pin wiring and common ground, DHT22 pull-up, sensor power, analog divider, and MQ-135 warm-up. Measure the GPIO 34 voltage before reconnecting the analog output. |
| LED does not switch | Check the LED polarity, resistor, and GPIO 25 wiring; check serial output and `/FirebaseIOT/led` in the database. The on-board LED pin varies by ESP32 board. |

## Checks

From `firmware/`, run `pio run` to compile the firmware. There are no separate dashboard build dependencies; serve it as above, sign in with a configured Firebase account, and verify a telemetry update and both LED command states. A configured Firebase project and physical ESP32/sensors are required for an end-to-end hardware test.
