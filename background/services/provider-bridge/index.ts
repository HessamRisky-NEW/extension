import browser from "webextension-polyfill"
import {
  EXTERNAL_PORT_NAME,
  PermissionRequest,
  AllowedQueryParamPage,
  PortRequestEvent,
  PortResponseEvent,
  EIP1193Error,
  RPCRequest,
  EIP1193_ERROR,
  ALLOWED_QUERY_PARAM_PAGE,
} from "@tallyho/provider-bridge-shared"
import { ServiceCreatorFunction, ServiceLifecycleEvents } from ".."
import logger from "../../lib/logger"
import BaseService from "../base"
import InternalEthereumProviderService from "../internal-ethereum-provider"
import { getOrCreateDB, ProviderBridgeServiceDatabase } from "./db"

type Events = ServiceLifecycleEvents & {
  requestPermission: PermissionRequest
}

/**
 * The ProviderBridgeService is responsible for the communication with the
 * provider-bridge (content-script).
 *
 * The main purpose for this service/layer is to provide a transition
 * between the untrusted communication from the window-provider - which runs
 * in shared dapp space and can be modified by other extensions - and our
 * internal service layer.
 *
 * The reponsibility of this service is 2 fold.
 * - Provide connection interface - handle port communication, connect, disconnect etc
 * - Validate the incoming communication and make sure that what we receive is what we expect
 */
export default class ProviderBridgeService extends BaseService<Events> {
  #allowedPages: {
    [url: string]: PermissionRequest
  } = {}

  #pendingPermissionsRequests: {
    [url: string]: (value: unknown) => void
  } = {}

  static create: ServiceCreatorFunction<
    Events,
    ProviderBridgeService,
    [Promise<InternalEthereumProviderService>]
  > = async (internalEthereumProviderService) => {
    return new this(
      await getOrCreateDB(),
      await internalEthereumProviderService
    )
  }

  private constructor(
    private db: ProviderBridgeServiceDatabase,
    private internalEthereumProviderService: InternalEthereumProviderService
  ) {
    super()

    browser.runtime.onConnect.addListener(async (port) => {
      if (port.name === EXTERNAL_PORT_NAME && port.sender?.url) {
        port.onMessage.addListener((event) => {
          this.onMessageListener(port as Required<browser.Runtime.Port>, event)
        })
        // TODO: store port with listener to handle cleanup
      }
    })

    // TODO: on internal provider handlers connect, disconnect, account change, network change
  }

  async onMessageListener(
    port: Required<browser.Runtime.Port>,
    event: PortRequestEvent
  ): Promise<void> {
    const url = port.sender.url as string
    const favIconUrl = port.sender.tab?.favIconUrl ?? ""
    const title = port.sender.tab?.title ?? ""

    // a port: browser.Runtime.Port is passed into this function as a 2nd argument by the port.onMessage.addEventListener.
    // This contradicts the MDN documentation so better not to rely on it.
    logger.log(`background: request payload: ${JSON.stringify(event.request)}`)

    const response: PortResponseEvent = { id: event.id, result: [] }

    if (await this.checkPermission(url)) {
      response.result = await this.routeContentScriptRPCRequest(
        event.request.method,
        event.request.params
      )
    } else if (event.request.method === "eth_requestAccounts") {
      const permissionRequest: PermissionRequest = {
        url,
        favIconUrl,
        title,
        state: "request",
      }

      const blockUntilUserAction = await this.requestPermission(
        permissionRequest
      )

      await blockUntilUserAction

      if (!(await this.checkPermission(url))) {
        response.result = new EIP1193Error(EIP1193_ERROR.userRejectedRequest)
      }
    } else {
      response.result = new EIP1193Error(EIP1193_ERROR.unauthorized)
    }

    logger.log("background response:", response)

    port.postMessage(response)
  }

  async requestPermission(permissionRequest: PermissionRequest) {
    this.emitter.emit("requestPermission", permissionRequest)
    await ProviderBridgeService.showDappConnectWindow(
      ALLOWED_QUERY_PARAM_PAGE.dappConnect
    )

    return new Promise((resolve) => {
      this.#pendingPermissionsRequests[permissionRequest.url] = resolve
    })
  }

  async grantPermission(permission: PermissionRequest): Promise<void> {
    if (this.#pendingPermissionsRequests[permission.url]) {
      this.#allowedPages[permission.url] = permission
      this.#pendingPermissionsRequests[permission.url](permission)
      delete this.#pendingPermissionsRequests[permission.url]
    }
  }

  async denyOrRevokePermission(permission: PermissionRequest): Promise<void> {
    if (this.#pendingPermissionsRequests[permission.url]) {
      delete this.#allowedPages[permission.url]
      this.#pendingPermissionsRequests[permission.url]("Time to move on")
      delete this.#pendingPermissionsRequests[permission.url]
    }
  }

  async checkPermission(url: string): Promise<boolean> {
    if (this.#allowedPages[url]?.state === "allow") return Promise.resolve(true)
    return Promise.resolve(false)
  }

  async routeContentScriptRPCRequest(
    method: string,
    params: RPCRequest["params"]
  ): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
        return this.internalEthereumProviderService.routeSafeRPCRequest(
          "eth_accounts",
          params
        )
      default: {
        return this.internalEthereumProviderService.routeSafeRPCRequest(
          method,
          params
        )
      }
    }
  }

  static async showDappConnectWindow(
    url: AllowedQueryParamPage
  ): Promise<browser.Windows.Window> {
    const { left = 0, top, width = 1920 } = await browser.windows.getCurrent()
    const popupWidth = 384
    const popupHeight = 558
    return browser.windows.create({
      url: `${browser.runtime.getURL("popup.html")}?page=${url}`,
      type: "popup",
      left: left + width - popupWidth,
      top,
      width: popupWidth,
      height: popupHeight,
      focused: true,
    })
  }
}