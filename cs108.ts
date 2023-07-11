import { Characteristic } from "react-native-ble-plx";
import { base64ToHex, hexToBase64, hexToNumber } from "../utils";

/*
There is a lot of documentation on the CS108 RFID reader here: https://www.convergence.com.hk/cs710s/
The docs include example native apps. We only use a small subset of the functionality.
*/

export const CS108_NAME_REGEX = "CS108";
export const CS108_EID_SERVICE_PREFIX = "00009800";
export const CS108_EID_SERVICE_CHARACTERISTIC_READ_PREFIX = "00009901";
export const CS108_EID_SERVICE_CHARACTERISTIC_WRITE_PREFIX = "00009900";

export const isCS108Device = (deviceName: string | null) => {
  if (!deviceName) {
    return false;
  }
  const regEx = new RegExp(CS108_NAME_REGEX, "gi");
  return regEx.test(deviceName);
};

const NOTIFICATION = {
  TRIGGER_PUSHED: "A102",
  TRIGGER_RELEASED: "A103",
};

const EVENT_CODE = {
  TAG_READ: "8100",
};

// Header values
const PREFIX = "A7"; // Byte 1
const CONNECTION = "B3"; // Byte 2
// Byte 3 is payload length (number of bytes in the payload)
const DESTINATION = {
  // Byte 4
  RFID: "C2",
  NOTIFICATION: "D9",
};
const RESERVED = "82"; // Byte 5 (but is a sequence number when uplink for RFID)
const DIRECTION = {
  // Byte 6
  Downlink: "D9",
  Uplink: "9E",
};
const DOWNLINK_CRC1 = "00";
const DOWNLINK_CRC2 = "00";
const DOWNLINK_PAYLOAD_LENGTH = "0A"; // 10 bytes
//CRC1 and CRC2 are bytes 7 and 8

const defaultCommandHeader =
  PREFIX +
  CONNECTION +
  DOWNLINK_PAYLOAD_LENGTH +
  DESTINATION.RFID +
  RESERVED +
  DIRECTION.Downlink +
  DOWNLINK_CRC1 +
  DOWNLINK_CRC2;

const RFID_COMMAND = "8002";

// Commands to send
const TURN_ON_RFID = "8000"; // Turn on RFID module
const ANT_PORT_SEL = RFID_COMMAND + "7001010700000000"; // Select the antenna port
const ANT_PORT_POWER = RFID_COMMAND + "700106072c010000"; // Set the output power for the logical antenna
const USE_CURRENT_PROFILE = RFID_COMMAND + "7001600b01000000"; // Use the current profile
const ENABLE_PROFILE = RFID_COMMAND + "700100F019000000";
const ANT_CYCLES = RFID_COMMAND + "70010007ffff0000"; // Specify the number of times the enabled logical antenna port should be cycled through in order to complete protocol command execution
const QUERY_CFG = RFID_COMMAND + "7001000920000000";
const INV_SEL = RFID_COMMAND + "7001020903000000";
const INV_ALG_PARM_0 = RFID_COMMAND + "70010309F6400000";
const INV_ALG_PARM_1 = RFID_COMMAND + "7001040900000000";
const INV_ALG_PARM_2 = RFID_COMMAND + "7001050901000000";
const INV_CFG = RFID_COMMAND + "7001010903000404";

const START_INVENTORY = RFID_COMMAND + "700100f00f000000";
const ABORT_INVENTORY = RFID_COMMAND + "4003000000000000";

const isNotification = (value: string) => {
  return value.substring(6, 8) === DESTINATION.NOTIFICATION;
};

const isRFID = (value: string) => {
  return value.substring(6, 8) === DESTINATION.RFID;
};

const getPayload = (value: string) => {
  return value.substring(16);
};

const getEventCode = (value: string) => {
  return value.substring(16, 20);
};

// EPC for the tags we have 018208A1CD5D948B3203007101000000, A1CD5D948B3203 reversed converts to the visual ID on the tag
const extractVIDFromEPC = (value: string) => {
  const reversedHex = value.substring(6, 20);
  const hexTag = reversedHex
    .match(/[a-fA-F0-9]{2}/g)
    ?.reverse()
    .join("");
  return hexToNumber(hexTag);
};

const SendCommand = async (command: string, writeCharacteristic?: Characteristic | null) => {
  if (!writeCharacteristic) {
    console.log("no writeCharacteristic");
    return;
  }
  const fullCommand = defaultCommandHeader + command;
  const commandBase64 = hexToBase64(fullCommand);
  await writeCharacteristic.writeWithResponse(commandBase64);
  console.log("BLE sent: ", fullCommand);
};

// Due to MTU limitation we don't get the tag read ble data in one go. We need to buffer it and then process it.
let currentDataStream = "";

const extractTagData = (payload: string) => {
  if (!payload || payload.length < 4) {
    throw new Error("Invalid payload");
  }
  const productCodeDecimal = hexToNumber(payload.substring(0, 4));
  if (!productCodeDecimal) {
    throw new Error("Invalid product code");
  }
  // eslint-disable-next-line no-bitwise
  const epcByteLength = (productCodeDecimal >> 11) * 2;
  const epc = payload.substring(4, 4 + epcByteLength * 2);
  const rssi = payload.substring(4 + epcByteLength * 2, 4 + epcByteLength * 2 + 2);
  const remainingPayload = payload.substring(4 + epcByteLength * 2 + 2);
  return { epc, rssi: hexToNumber(rssi), remainingPayload };
};

/* We want something like this (spaces are only there in this comment to make it more readable):
A7B330C2259E994A 8100 04 00 0580 2600 00 00 4000 018208A1CD5D948B3203007101000000 60 4000 018207B4CD5D948B3203008401000000 5C
*/
const processTagData = () => {
  if (!currentDataStream) {
    return;
  }
  try {
    let tagReadPayload = currentDataStream.substring(36);
    while (tagReadPayload.length > 0) {
      const { epc, remainingPayload } = extractTagData(tagReadPayload);
      console.log("VID: ", extractVIDFromEPC(epc));
      tagReadPayload = remainingPayload;
    }
  } catch (error) {
    console.log("error: ", error);
    currentDataStream = "";
    return;
  }

  currentDataStream = "";
};

export const processCS108Data = (value: string, writeCharacteristic?: Characteristic | null) => {
  const decodedValue = base64ToHex(value);
  if (isNotification(decodedValue)) {
    processTagData();
    const payload = getPayload(decodedValue);
    switch (payload) {
      case NOTIFICATION.TRIGGER_PUSHED:
        console.log("trigger pushed");
        SendCommand(START_INVENTORY, writeCharacteristic);
        break;
      case NOTIFICATION.TRIGGER_RELEASED:
        console.log("trigger released");
        SendCommand(ABORT_INVENTORY, writeCharacteristic);
        break;
    }
    return;
  }
  if (isRFID(decodedValue)) {
    processTagData();
    const eventCode = getEventCode(decodedValue);
    switch (eventCode) {
      case RFID_COMMAND:
        console.log("RFID command confirmation: ", decodedValue);
        break;
      case EVENT_CODE.TAG_READ:
        currentDataStream = decodedValue;
        console.log("tag read:", decodedValue);
        break;
    }
    return;
  }
  console.log("BLE recieved and not processed: ", decodedValue);
  currentDataStream += decodedValue;
  return {}; // We don't return tag data here as this is done in processTagData
};

/*
Issue commands required to turn on RFID and setup ready for scanning
*/
export const startRFIDReader = async (writeCharacteristic: Characteristic) => {
  const commands = [
    TURN_ON_RFID,
    ANT_PORT_SEL,
    ANT_PORT_POWER,
    USE_CURRENT_PROFILE,
    ENABLE_PROFILE,
    ANT_CYCLES,
    QUERY_CFG,
    INV_SEL,
    INV_ALG_PARM_0,
    INV_ALG_PARM_1,
    INV_ALG_PARM_2,
    INV_CFG,
  ];

  commands.forEach((command) => {
    SendCommand(command, writeCharacteristic);
  });
};
