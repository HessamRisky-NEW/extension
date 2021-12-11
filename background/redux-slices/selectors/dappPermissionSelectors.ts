import { createSelector } from "@reduxjs/toolkit"
import { RootState } from ".."
import { DAppPermissionState } from "../dapp-permission"

export const getProviderBridgeState = (state: RootState) => state.dappPermission

export const selectPermissionRequests = createSelector(
  getProviderBridgeState,
  (slice: DAppPermissionState) => Object.values(slice.permissionRequests)
)

export const selectPendingPermissionRequests = createSelector(
  selectPermissionRequests,
  (permissionRequests) => {
    return permissionRequests.filter((p) => p.state === "request")
  }
)

export const selectCurrentPendingPermission = createSelector(
  selectPendingPermissionRequests,
  (permissionRequests) => {
    return permissionRequests[0]
  }
)