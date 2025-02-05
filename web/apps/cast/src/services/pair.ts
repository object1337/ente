import log from "@/next/log";
import { boxSealOpen, toB64 } from "@ente/shared/crypto/internal/libsodium";
import castGateway from "@ente/shared/network/cast";
import { wait } from "@ente/shared/utils";
import _sodium from "libsodium-wrappers";
import { type Cast } from "../utils/cast-receiver";

export interface Registration {
    /** A pairing code shown on the screen. A client can use this to connect. */
    pairingCode: string;
    /** The public part of the keypair we registered with the server. */
    publicKeyB64: string;
    /** The private part of the keypair we registered with the server. */
    privateKeyB64: string;
}

/**
 * Register a keypair with the server and return a pairing code that can be used
 * to connect to us. Phase 1 of the pairing protocol.
 *
 * [Note: Pairing protocol]
 *
 * The Chromecast Framework (represented here by our handle to the Chromecast
 * Web SDK, {@link cast}) itself is used for only the initial handshake, none of
 * the data, even encrypted passes over it thereafter.
 *
 * The pairing happens in two phases:
 *
 * Phase 1 - {@link register}
 *
 * 1. We (the receiver) generate a public/private keypair. and register the
 *    public part of it with museum.
 *
 * 2. Museum gives us a pairing "code" in lieu. Show this on the screen.
 *
 * Phase 2 - {@link advertiseCode}
 *
 * There are two ways the client can connect - either by sending us a blank
 * message over the Chromecast protocol (to which we'll reply with the pairing
 * code), or by the user manually entering the pairing code on their screen.
 *
 * 3. Listen for incoming messages over the Chromecast connection.
 *
 * 4. The client (our Web or mobile app) will connect using the "sender"
 *    Chromecast SDK. This will result in a bi-directional channel between us
 *    ("receiver") and the Ente client app ("sender").
 *
 * 5. Thereafter, if at any time the sender disconnects, close the Chromecast
 *    context. This effectively shuts us down, causing the entire page to get
 *    reloaded.
 *
 * 6. After connecting, the sender sends an (empty) message. We reply by sending
 *    them a message containing the pairing code. This exchange is the only data
 *    that traverses over the Chromecast connection.
 *
 * Once the client gets the pairing code (via Chromecast or manual entry),
 * they'll let museum know. So in parallel with Phase 2, we perform Phase 3.
 *
 * Phase 3 - {@link getCastData} in a setInterval.
 *
 * 7. Keep polling museum to ask it if anyone has claimed that code we vended
 *    out and used that to send us an payload encrypted using our public key.
 *
 * 8. When that happens, decrypt that data with our private key, and return this
 *    payload. It is a JSON object that contains the data we need to initiate a
 *    slideshow for a particular Ente collection.
 *
 * Phase 1 (Steps 1 and 2) are done by the {@link register} function, which
 * returns a {@link Registration}.
 *
 * At this time we start showing the pairing code on the UI, and start phase 2,
 * {@link advertiseCode} to vend out the pairing code to Chromecast connections.
 *
 * In parallel, we start Phase 3, calling {@link getCastData} in a loop. Once we
 * get a response, we decrypt it to get the data we need to start the slideshow.
 */
export const register = async (): Promise<Registration> => {
    // Generate keypair.
    const keypair = await generateKeyPair();
    const publicKeyB64 = await toB64(keypair.publicKey);
    const privateKeyB64 = await toB64(keypair.privateKey);

    // Register keypair with museum to get a pairing code.
    let pairingCode: string;
    // eslint has fixed this spurious warning, but we're not on the latest
    // version yet, so add a disable.
    // https://github.com/eslint/eslint/pull/18286
    /* eslint-disable no-constant-condition */
    while (true) {
        try {
            pairingCode = await castGateway.registerDevice(publicKeyB64);
        } catch (e) {
            log.error("Failed to register public key with server", e);
        }
        if (pairingCode) break;
        // Schedule retry after 10 seconds.
        await wait(10000);
    }

    return { pairingCode, publicKeyB64, privateKeyB64 };
};

/**
 * Listen for incoming messages on the given {@link cast} receiver, replying to
 * each of them with a pairing code obtained using the given {@link pairingCode}
 * callback. Phase 2 of the pairing protocol.
 *
 * See: [Note: Pairing protocol].
 */
export const advertiseCode = (
    cast: Cast,
    pairingCode: () => string | undefined,
) => {
    // Prepare the Chromecast "context".
    const context = cast.framework.CastReceiverContext.getInstance();
    const namespace = "urn:x-cast:pair-request";

    const options = new cast.framework.CastReceiverOptions();
    // We don't use the media features of the Cast SDK.
    options.skipPlayersLoad = true;
    // Do not stop the casting if the receiver is unreachable. A user should be
    // able to start a cast on their phone and then put it away, leaving the
    // cast running on their big screen.
    options.disableIdleTimeout = true;

    // The collection ID with which we paired. If we get another connection
    // request for a different collection ID, restart the app to allow them to
    // reconnect using a freshly generated pairing code.
    //
    // If the request does not have a collectionID, forego this check.
    let pairedCollectionID: string | undefined;

    type ListenerProps = {
        senderId: string;
        data: unknown;
    };

    // Reply with the code that we have if anyone asks over Chromecast.
    const incomingMessageListener = ({ senderId, data }: ListenerProps) => {
        const restart = (reason: string) => {
            log.error(`Restarting app because ${reason}`);
            // context.stop will close the tab but it'll get reopened again
            // immediately since the client app will reconnect in the scenarios
            // where we're calling this function.
            context.stop();
        };

        const collectionID =
            data &&
            typeof data == "object" &&
            typeof data["collectionID"] == "string"
                ? data["collectionID"]
                : undefined;

        if (pairedCollectionID && pairedCollectionID != collectionID) {
            restart(`incoming request for a new collection ${collectionID}`);
            return;
        }

        pairedCollectionID = collectionID;

        const code = pairingCode();
        if (!code) {
            // Our caller waits until it has a pairing code before it calls
            // `advertiseCode`, but there is still an edge case where we can
            // find ourselves without a pairing code:
            //
            // 1. The current pairing code expires. We start the process to get
            //    a new one.
            //
            // 2. But before that happens, someone connects.
            //
            // The window where this can happen is short, so if we do find
            // ourselves in this scenario,
            restart("we got a pairing request when refreshing pairing codes");
            return;
        }

        context.sendCustomMessage(namespace, senderId, { code });
    };

    context.addCustomMessageListener(
        namespace,
        // We need to cast, the `senderId` is present in the message we get but
        // not present in the TypeScript type.
        incomingMessageListener as unknown as SystemEventHandler,
    );

    // Close the (chromecast) tab if the sender disconnects.
    //
    // Chromecast does a "shutdown" of our cast app when we call `context.stop`.
    // This translates into it closing the tab where it is showing our app.
    context.addEventListener(
        cast.framework.system.EventType.SENDER_DISCONNECTED,
        () => context.stop(),
    );

    // Start listening for Chromecast connections.
    context.start(options);
};

/**
 * Ask museum if anyone has sent a (encrypted) payload corresponding to the
 * given pairing code. If so, decrypt it using our private key and return the
 * JSON payload. Phase 3 of the pairing protocol.
 *
 * Returns `undefined` if there hasn't been any data obtained yet.
 *
 * See: [Note: Pairing protocol].
 */
export const getCastData = async (registration: Registration) => {
    const { pairingCode, publicKeyB64, privateKeyB64 } = registration;

    // The client will send us the encrypted payload using our public key that
    // we registered with museum.
    const encryptedCastData = await castGateway.getCastData(pairingCode);
    if (!encryptedCastData) return;

    // Decrypt it using the private key of the pair and return the plaintext
    // payload, which'll be a JSON object containing the data we need to start a
    // slideshow for some collection.
    const decryptedCastData = await boxSealOpen(
        encryptedCastData,
        publicKeyB64,
        privateKeyB64,
    );

    return JSON.parse(atob(decryptedCastData));
};

const generateKeyPair = async () => {
    await _sodium.ready;
    return _sodium.crypto_box_keypair();
};
