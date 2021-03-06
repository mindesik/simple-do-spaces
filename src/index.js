import AWS from 'aws-sdk';
import fs from 'fs';
import nodePath from 'path';
import mime from 'mime-types';
import axios from 'axios';
import { backOff } from 'exponential-backoff';

const SortOrder = {
  ASC: 'ASC',
  DESC: 'DESC'
};

function sortFilesByDate(filesList, sortByDate = SortOrder.ASC) {
  const result = filesList.sort((a, b) => {
    if (sortByDate === SortOrder.DESC) {
      return b.lastModified.getTime() - a.lastModified.getTime();
    }
    return a.lastModified.getTime() - b.lastModified.getTime();
  });

  return result;
}

class SpacesClient {
  constructor(
    endpoint,
    bucket,
    accessKeyId = null,
    secretAccessKey = null,
    digitalOceanAPIToken = null,
    cdnEndpointId = null,
    customCdnHost = null,
  ) {
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.digitalOceanAPIToken = digitalOceanAPIToken;
    this.cdnEndpointId = cdnEndpointId;
    this.customCdnHost = customCdnHost;

    const options = {
      endpoint,
    };

    if (accessKeyId) {
      options.accessKeyId = accessKeyId;
    }
    if (secretAccessKey) {
      options.secretAccessKey = secretAccessKey;
    }

    this.s3client = new AWS.S3(options);
  }

  getURL(path) {
    return `https://${this.bucket}.${this.endpoint}/${path}`;
  }

  getCDNURL(path) {
    const url = this.getURL(path);
    const cdnUrl = new URL(url);

    if (this.customCdnHost) {
      cdnUrl.host = this.customCdnHost;
    } else {
      cdnUrl.host = 'cdn.digitaloceanspaces';
    }

    return cdnUrl.href;
  }

  async getPresignedURL(path, expires = 900) {
    return this.s3client.getSignedUrlPromise('getObject', {
      Bucket: this.bucket,
      Key: path,
      Expires: expires,
    });
  }

  async isFilePublic(filePath) {
    const acl = await this.s3client.getObjectAcl({
      Bucket: this.bucket,
      Key: filePath,
    }).promise();

    const isPublic = acl.Grants.some(({ Grantee, Permission }) => {
      const isAllUsers = Grantee.URI && Grantee.URI.match(/AllUsers/);
      const isRead = Permission === 'READ';
      return isAllUsers && isRead;
    });
    return isPublic;
  }

  async getCDNEndpointId() {
    if (!this.digitalOceanAPIToken) {
      throw new Error('No API Token configured');
    }

    if (this.cdnEndpointId) {
      return this.cdnEndpointId;
    }

    const cdnEndpointsResponse = await axios.request({
      url: 'https://api.digitalocean.com/v2/cdn/endpoints',
      headers: {
        Authorization: `Bearer ${this.digitalOceanAPIToken}`,
      },
    });
    const cdnEndpoints = cdnEndpointsResponse.data.endpoints;
    const currentCdnEndpoint = cdnEndpoints.find(({ origin }) => {
      const [endpointBucket] = origin.split('.');
      return this.bucket === endpointBucket;
    });

    if (!currentCdnEndpoint) {
      throw new Error(`No CDN endpoint found for bucket: ${this.bucket}`);
    }

    this.cdnEndpointId = currentCdnEndpoint.id;
    return this.cdnEndpointId;
  }

  async uploadFile(
    uploadFilePath,
    destinationPath,
    permission = 'private',
    options = {},
  ) {
    const { exponentialBackoff = false, purgeCache = false, ...spacesOptions } = options;
    const makeUpload = async () => {
      await this.s3client.upload({
        Bucket: this.bucket,
        Body: fs.createReadStream(uploadFilePath),
        Key: destinationPath,
        ACL: permission === 'public' ? 'public-read' : permission,
        // ContentDisposition: 'attachment',
        ContentType: mime.lookup(uploadFilePath),
        ...spacesOptions,
      }).promise();

      if (purgeCache) {
        const cdnEndpointId = await this.getCDNEndpointId();
        await axios.request({
          url: `https://api.digitalocean.com/v2/cdn/endpoints/${cdnEndpointId}/cache`,
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.digitalOceanAPIToken}`,
          },
          data: {
            files: [destinationPath],
          },
        });
      }

      return this.getCDNURL(destinationPath);
    };

    if (exponentialBackoff) {
      return backOff(() => makeUpload());
    }

    return makeUpload();
  }

  async listPathObjects(path) {
    const data = await this.s3client.listObjectsV2({
      Bucket: this.bucket,
      Prefix: path,
    }).promise();

    return data.Contents;
  }

  /**
   * List files at path sorting them by Last Modified date.
   * @param {String} path Path in DO Spaces to list files
   * @param {Object} options Options for the list
   * @param {('ASC'|'DESC')} options.sortByDate Sorting order 'ASC' or 'DESC'. 'ASC' is default.
   * @param {Boolean} options.pathOnly If true it will not return the complete
   * URL just the path in DO Spaces
   */
  async listPathFiles(path, options = {}) {
    const { sortByDate, pathOnly = false } = options;
    const objects = await this.listPathObjects(path);
    const filesList = objects.map(({ Key, LastModified }) => ({
      url: pathOnly ? Key : this.getCDNURL(Key),
      lastModified: LastModified
    }));

    return sortFilesByDate(filesList, sortByDate);
  }

  async deleteObjects(objects) {
    return this.s3client.deleteObjects({
      Bucket: this.bucket,
      Delete: {
        Objects: objects.map(object => ({
          Key: object.Key,
        })),
      },
    }).promise();
  }

  async deletePaths(paths) {
    const objects = paths.map(path => ({
      Key: path,
    }));
    return this.deleteObjects(objects);
  }

  async deleteFile(path) {
    return this.deleteObjects([{
      Key: path,
    }]);
  }

  async deleteFolder(folderPath) {
    const objects = await this.listPathObjects(folderPath);
    return this.deleteObjects(objects);
  }

  async copyFile(
    sourcePath,
    destinationPath,
  ) {
    const isSourcePublic = await this.isFilePublic(sourcePath);

    return this.s3client.copyObject({
      Bucket: this.bucket,
      CopySource: `/${this.bucket}/${sourcePath}`,
      Key: destinationPath,
      ACL: isSourcePublic ? 'public-read' : 'private',
    }).promise();
  }

  async downloadFile(
    filePathToRead,
    filePathToSave,
    createDirIfNotExists = true
  ) {
    if (createDirIfNotExists) {
      const parentPath = nodePath.dirname(filePathToSave);
      await fs.promises.mkdir(parentPath, { recursive: true });
    }

    return new Promise((resolve, reject) => {
      const fileWriteStream = fs.createWriteStream(filePathToSave);

      this.s3client.getObject({
        Bucket: this.bucket,
        Key: filePathToRead,
      })
        .on('error', (error) => {
          fs.unlinkSync(filePathToSave);
          reject(error);
        })
        .createReadStream()
        .pipe(fileWriteStream);


      fileWriteStream.on('finish', () => {
        resolve(filePathToSave);
      });
    });
  }
}

export default SpacesClient;
