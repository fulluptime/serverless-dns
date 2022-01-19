/*
 * Copyright (c) 2021 RethinkDNS and its authors.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import * as dnsutil from "../../commons/dnsutil.js";
import * as bufutil from "../../commons/bufutil.js";
import * as util from "../../commons/util.js";
import * as envutil from "../../commons/envutil.js";

export default class DNSResolver {
  constructor() {
    this.http2 = null;
    this.nodeUtil = null;
    this.transport = null;
    this.log = log.withTags("DnsResolver");
    this.preferredDohResolvers = [
      envutil.dohResolver(),
      envutil.secondaryDohResolver(),
    ];
  }

  async lazyInit() {
    if (envutil.isNode() && !this.http2) {
      this.http2 = await import("http2");
      this.log.i("created custom http2 client");
    }
    if (envutil.isNode() && !this.nodeUtil) {
      this.nodeUtil = await import("../../core/node/util.js");
      this.log.i("imported node-util");
    }
    if (envutil.isNode() && !this.transport) {
      const plainOldDnsIp = dnsutil.dnsIpv4();
      this.transport = new (
        await import("../../core/node/dns-transport.js")
      ).Transport(plainOldDnsIp, 53);
      this.log.i("created udp/tcp dns transport", plainOldDnsIp);
    }
  }

  /**
   * @param {Object} param
   * @param {String} param.rxid
   * @param {Request} param.request
   * @param {ArrayBuffer} param.requestBodyBuffer
   * @param {DnsDecodeObject} param.requestDecodedDnsPacket
   * @param {Worker-Event} param.event
   * @param {String} param.userDnsResolverUrl
   * @param {} param.blocklistFilter
   * @param {DnsCache} param.dnsCache
   * @returns
   */
  async RethinkModule(param) {
    await this.lazyInit();
    let response = util.emptyResponse();

    try {
      response.data = await this.resolveDns(param);
    } catch (e) {
      response = util.errResponse("dnsResolver", e);
      this.log.e(param.rxid, "main", e);
    }

    return response;
  }

  determineDohResolvers(param) {
    // when this.transport is set, do not use doh
    if (this.transport) return [];

    const preferredByUser = param.userDnsResolverUrl;
    if (!util.emptyString(preferredByUser)) {
      return [preferredByUser];
    } else if (envutil.isWorkers()) {
      // upstream to two resolvers on workers; since egress is free,
      // faster among the 2 should help lower tail latencies at zero-cost
      return this.preferredDohResolvers;
    }
    return envutil.dohResolver();
  }

  async resolveDns(param) {
    const rxid = param.rxid;
    const upstreams = this.determineDohResolvers(param);
    const upRes = await this.resolveDnsUpstream(
      rxid,
      param.request,
      upstreams,
      param.requestBodyBuffer
    );
    return await this.decodeResponse(rxid, upRes);
  }

  async decodeResponse(rxid, response) {
    if (!response) throw new Error("no upstream result");

    if (!response.ok) {
      const txt = await response.text();
      this.log.d(rxid, "!OK", response.status, response.statusText, txt);
      throw new Error(response.status + " http err: " + response.statusText);
    }

    const dnsBuffer = await response.arrayBuffer();
    const dnsPacket = dnsutil.decode(dnsBuffer);

    return {
      dnsPacket: dnsPacket,
      dnsBuffer: dnsBuffer,
    };
  }
}

/**
 * @param {String} rxid
 * @param {Request} request
 * @param {Array} resolverUrls
 * @param {ArrayBuffer} query
 * @returns
 */
DNSResolver.prototype.resolveDnsUpstream = async function (
  rxid,
  request,
  resolverUrls,
  query
) {
  // if no doh upstreams set, resolve over plain-old dns
  if (util.emptyArray(resolverUrls)) {
    const q = bufutil.bufferOf(query);

    let ans = await this.transport.udpquery(rxid, q);
    if (ans && dnsutil.truncated(ans)) {
      this.log.w(rxid, "ans truncated, retrying over tcp");
      ans = await this.transport.tcpquery(rxid, q);
    }

    return ans ? new Response(bufutil.arrayBufferOf(ans)) : util.respond503();
  }

  const promisedRes = [Promise.reject(new Error("no upstream"))];
  for (const rurl of resolverUrls) {
    if (util.emptyString(rurl)) {
      this.log.w(rxid, "missing resolver url", rurl);
      continue;
    }
    const u = new URL(request.url);
    const upstream = new URL(rurl);
    u.hostname = upstream.hostname; // default cloudflare-dns.com
    u.pathname = upstream.pathname; // override path, default /dns-query
    u.port = upstream.port; // override port, default 443
    u.protocol = upstream.protocol; // override proto, default https

    let dnsreq = null;
    // even for GET requests, plugin.js:getBodyBuffer converts contents of
    // u.search into an arraybuffer that then needs to be reconverted back
    if (util.isGetRequest(request)) {
      u.search = "?dns=" + bufutil.bytesToBase64Url(query);
      dnsreq = new Request(u.href, {
        method: "GET",
      });
    } else if (util.isPostRequest(request)) {
      dnsreq = new Request(u.href, {
        method: "POST",
        headers: util.concatHeaders(
          util.contentLengthHeader(query),
          util.dnsHeaders()
        ),
        body: query,
      });
    } else {
      return Promise.reject(new Error("get/post requests only"));
    }
    promisedRes.push(this.http2 ? this.doh2(rxid, dnsreq) : fetch(dnsreq));
  }
  // Promise.any returns any rejected promise if none resolved; node v15+
  return Promise.any(promisedRes);
};

/**
 * Resolve DNS request using HTTP/2 API of Node.js
 * @param {String} rxid - request id
 * @param {Request} request - Request object
 * @returns {Promise<Response>}
 */
DNSResolver.prototype.doh2 = async function (rxid, request) {
  if (!this.http2 || !this.nodeUtil) {
    throw new Error("h2 / node-util not setup, bailing");
  }

  this.log.d(rxid, "upstream with doh2");
  const http2 = this.http2;
  const transformPseudoHeaders = this.nodeUtil.transformPseudoHeaders;

  const u = new URL(request.url);
  const upstreamQuery = bufutil.bufferOf(await request.arrayBuffer());
  const headers = util.copyHeaders(request);

  return new Promise((resolve, reject) => {
    // TODO: h2 conn re-use: archive.is/XXKwn
    // TODO: h2 conn pool
    const authority = u.origin;
    const c = http2.connect(authority);

    c.on("error", (err) => {
      reject(err.message);
    });

    const req = c.request({
      [http2.constants.HTTP2_HEADER_METHOD]: request.method,
      [http2.constants.HTTP2_HEADER_PATH]: `${u.pathname}`,
      ...headers,
    });

    req.on("response", (headers) => {
      const b = [];
      req.on("data", (chunk) => {
        b.push(chunk);
      });
      req.on("end", () => {
        const rb = bufutil.concatBuf(b);
        const h = transformPseudoHeaders(headers);
        util.safeBox(c.close);
        resolve(new Response(rb, h));
      });
    });
    // nodejs' async err events go unhandled when the handler
    // is not registered, which ends up killing the process
    req.on("error", (err) => {
      reject(err.message);
    });

    // req.end write query to upstream over http2.
    // do this only after the event-handlers (response,
    // on, end, error etc) have been registered (above),
    // and not before. Those events aren't resent by
    // nodejs; while they may in fact happen immediately
    // post a req.write / req.end (for ex: an error if it
    // happens pronto, before an event-handler could be
    // registered, then the err would simply go unhandled)
    req.end(upstreamQuery);
  });
};
