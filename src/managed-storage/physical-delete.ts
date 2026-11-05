import {
  S3Client,
  GetBucketVersioningCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { config } from "../config";
import { requireCondition, StorageDelegationError } from "./contract";

/** No caller URLs/headers/keys: only objectKey(row) inside the managed namespace. */
export function physicalRemover(
  client?: Pick<S3Client, "send">,
  policy = () => process.env.MANAGED_STORAGE_PHYSICAL_DELETE_POLICY,
) {
  const bucket = config.storage.s3Bucket;
  const sdk =
    client ??
    new S3Client({
      region: config.storage.s3Region,
      endpoint: config.storage.s3Endpoint,
      forcePathStyle: config.storage.s3ForcePathStyle,
      maxAttempts: 1,
      credentials: {
        accessKeyId: config.storage.s3AccessKey,
        secretAccessKey: config.storage.s3SecretKey,
      },
    });
  return async (key: string, signal: AbortSignal): Promise<void> => {
    requireCondition(
      /^managed-app-storage\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(
        key,
      ),
      "storage_physical_key_invalid",
      409,
    );
    // Operator attests IAM/provider policy excludes versioning changes and external writers for this namespace.
    requireCondition(
      policy() === "never-versioned-exclusive-writer",
      "storage_physical_policy_required",
      409,
    );
    const unversioned = async () => {
      const version = await sdk.send(
        new GetBucketVersioningCommand({ Bucket: bucket }),
        { abortSignal: signal },
      );
      requireCondition(
        version.$metadata.httpStatusCode === 200 &&
          !version.Status &&
          !version.MFADelete,
        "storage_versioned_delete_unsupported",
        409,
      );
    };
    try {
      await unversioned();
      const result = await sdk.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        { abortSignal: signal },
      );
      requireCondition(
        result.$metadata.httpStatusCode === 204 &&
          !result.DeleteMarker &&
          !result.VersionId,
        "storage_physical_delete_unconfirmed",
        409,
      );
      let absent = false;
      try {
        await sdk.send(new HeadObjectCommand({ Bucket: bucket, Key: key }), {
          abortSignal: signal,
        });
      } catch (error: any) {
        absent =
          error?.$metadata?.httpStatusCode === 404 &&
          !error?.$response?.headers?.["x-amz-delete-marker"];
        if (!absent) throw error;
      }
      requireCondition(absent, "storage_physical_delete_unconfirmed", 409);
      await unversioned();
      signal.throwIfAborted();
    } catch (error) {
      if (error instanceof StorageDelegationError) throw error;
      throw new StorageDelegationError(
        "storage_physical_delete_unconfirmed",
        503,
      );
    }
  };
}
