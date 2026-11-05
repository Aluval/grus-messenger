
import {
  generateIdentityKeyPair,
  deriveConversationKey,
  encryptMessage,
  decryptMessage,
} from "./crypto.js";

async function runCryptoTests() {
  console.log("🔐 GRUS Messaging Encryption Tests Started");

  const conversationId = "grus-test-conversation-001";

  // TEST 1: Generate Alice and Bob identities.
  console.log("\nTEST 1: Generating Alice and Bob identities...");

  const alice = await generateIdentityKeyPair();
  const bob = await generateIdentityKeyPair();

  console.log("✅ Alice identity generated");
  console.log("✅ Bob identity generated");

  // TEST 2: Derive conversation keys independently.
  console.log("\nTEST 2: Deriving shared conversation keys...");

  const aliceKey = await deriveConversationKey(
    alice.privateKey,
    bob.publicKey,
    conversationId
  );

  const bobKey = await deriveConversationKey(
    bob.privateKey,
    alice.publicKey,
    conversationId
  );

  console.log("✅ Alice derived conversation key");
  console.log("✅ Bob derived conversation key");

  // TEST 3: Alice encrypts a message.
  console.log("\nTEST 3: Encrypting Alice's message...");

  const originalMessage = "Hello Bob! This is a private GRUS message.";

  const encryptedPayload = await encryptMessage(
    originalMessage,
    aliceKey,
    conversationId
  );

  console.log("✅ Message encrypted");
  console.log("Encrypted payload:", encryptedPayload);

  // TEST 4: Bob decrypts Alice's message.
  console.log("\nTEST 4: Bob decrypts Alice's message...");

  const decryptedMessage = await decryptMessage(
    encryptedPayload,
    bobKey,
    conversationId
  );

  if (decryptedMessage !== originalMessage) {
    throw new Error("Decrypted message does not match original.");
  }

  console.log("✅ Message decrypted correctly");
  console.log("Original:", originalMessage);
  console.log("Decrypted:", decryptedMessage);

  // TEST 5: Wrong conversation ID must fail.
  console.log("\nTEST 5: Checking wrong conversation ID...");

  let wrongConversationRejected = false;

  try {
    await decryptMessage(
      encryptedPayload,
      bobKey,
      "another-conversation"
    );
  } catch {
    wrongConversationRejected = true;
  }

  if (!wrongConversationRejected) {
    throw new Error("Wrong conversation ID was not rejected.");
  }

  console.log("✅ Wrong conversation ID rejected");

  // TEST 6: Modified ciphertext must fail.
  console.log("\nTEST 6: Checking modified ciphertext...");

  const parsedPayload = JSON.parse(encryptedPayload);
  const ciphertextBytes = Uint8Array.from(
    atob(parsedPayload.ciphertext),
    (character) => character.charCodeAt(0)
  );

  ciphertextBytes[0] ^= 1;

  const modifiedPayload = JSON.stringify({
    ...parsedPayload,
    ciphertext: btoa(
      String.fromCharCode(...ciphertextBytes)
    ),
  });

  let tamperingRejected = false;

  try {
    await decryptMessage(
      modifiedPayload,
      bobKey,
      conversationId
    );
  } catch {
    tamperingRejected = true;
  }

  if (!tamperingRejected) {
    throw new Error("Modified ciphertext was not rejected.");
  }

  console.log("✅ Modified ciphertext rejected");

  console.log("\n🎉 ALL SIX GRUS MESSAGING TESTS PASSED");
}

runCryptoTests().catch((error) => {
  console.error("\n❌ GRUS ENCRYPTION TEST FAILED");
  console.error(error);
});
