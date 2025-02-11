import { Signer } from '@ethersproject/abstract-signer'
import { CallOverrides, Contract } from '@ethersproject/contracts'
import { BlockTag, JsonRpcProvider, Provider, TransactionReceipt } from '@ethersproject/providers'
import { getContractForNetwork } from './configuration'
import {
  address,
  DEFAULT_REGISTRY_ADDRESS,
  interpretIdentifier,
  MESSAGE_PREFIX,
  MetaSignature,
  stringToBytes32,
} from './helpers'
import { arrayify, concat, hexConcat, hexlify, zeroPad } from '@ethersproject/bytes'
import { keccak256 } from '@ethersproject/keccak256'
import { formatBytes32String, toUtf8Bytes } from '@ethersproject/strings'

/**
 * A class that can be used to interact with the ERC1056 contract on behalf of a local controller key-pair
 */
export class EthrDidController {
  private contract: Contract
  private readonly signer?: Signer
  private readonly address: string
  public readonly did: string
  private readonly legacyNonce: boolean

  /**
   * Creates an EthrDidController instance.
   *
   * @param identifier - required - a `did:ethr` string or a publicKeyHex or an ethereum address
   * @param signer - optional - a Signer that represents the current controller key (owner) of the identifier. If a
   *   'signer' is not provided, then a 'contract' with an attached signer can be used.
   * @param contract - optional - a Contract instance representing a ERC1056 contract. At least one of `contract`,
   *   `provider`, or `rpcUrl` is required
   * @param chainNameOrId - optional - the network name or chainID, defaults to 'mainnet'
   * @param provider - optional - a web3 Provider. At least one of `contract`, `provider`, or `rpcUrl` is required
   * @param rpcUrl - optional - a JSON-RPC URL that can be used to connect to an ethereum network. At least one of
   *   `contract`, `provider`, or `rpcUrl` is required
   * @param registry - optional - The ERC1056 registry address. Defaults to
   *   '0xdca7ef03e98e0dc2b855be647c39abe984fcf21b'. Only used with 'provider' or 'rpcUrl'
   * @param legacyNonce - optional - If the legacy nonce tracking method should be accounted for. If lesser version of
   *   did-ethr-registry contract v1.0.0 is used then this should be true.
   */
  constructor(
    identifier: string | address,
    contract?: Contract,
    signer?: Signer,
    chainNameOrId = 'mainnet',
    provider?: Provider,
    rpcUrl?: string,
    registry: string = DEFAULT_REGISTRY_ADDRESS,
    legacyNonce = true
  ) {
    this.legacyNonce = legacyNonce
    // initialize identifier
    const { address, publicKey, network } = interpretIdentifier(identifier)
    const net = network || chainNameOrId
    // initialize contract connection
    if (contract) {
      this.contract = contract
    } else if (provider || signer?.provider || rpcUrl) {
      const prov = provider || signer?.provider
      this.contract = getContractForNetwork({ name: net, provider: prov, registry, rpcUrl })
    } else {
      throw new Error(' either a contract instance or a provider or rpcUrl is required to initialize')
    }
    this.signer = signer
    this.address = address
    let networkString = net ? `${net}:` : ''
    if (networkString in ['mainnet:', '0x1:']) {
      networkString = ''
    }
    this.did = publicKey ? `did:ethr:${networkString}${publicKey}` : `did:ethr:${networkString}${address}`
  }

  async getOwner(address: address, blockTag?: BlockTag): Promise<string> {
    const result = await this.contract.functions.identityOwner(address, { blockTag })
    return result[0]
  }

  async attachContract(controller?: address | Promise<address>): Promise<Contract> {
    const currentOwner = controller ? await controller : await this.getOwner(this.address, 'latest')
    const signer = this.signer
      ? this.signer
      : (<JsonRpcProvider>this.contract.provider).getSigner(currentOwner) || this.contract.signer
    return this.contract.connect(signer)
  }

  async changeOwner(newOwner: address, options: CallOverrides = {}): Promise<TransactionReceipt> {
    // console.log(`changing owner for ${oldOwner} on registry at ${registryContract.address}`)
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }

    const contract = await this.attachContract(overrides.from)
    delete overrides.from

    const ownerChange = await contract.functions.changeOwner(this.address, newOwner, overrides)
    return await ownerChange.wait()
  }

  async createChangeOwnerHash(newOwner: address) {
    const paddedNonce = await this.getPaddedNonceCompatibility()

    const dataToHash = hexConcat([
      MESSAGE_PREFIX,
      this.contract.address,
      paddedNonce,
      this.address,
      concat([toUtf8Bytes('changeOwner'), newOwner]),
    ])
    return keccak256(dataToHash)
  }

  async changeOwnerSigned(
    newOwner: address,
    metaSignature: MetaSignature,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }

    const contract = await this.attachContract(overrides.from)
    delete overrides.from

    const ownerChange = await contract.functions.changeOwnerSigned(
      this.address,
      metaSignature.sigV,
      metaSignature.sigR,
      metaSignature.sigS,
      newOwner,
      overrides
    )
    return await ownerChange.wait()
  }

  async addDelegate(
    delegateType: string,
    delegateAddress: address,
    exp: number,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }
    const contract = await this.attachContract(overrides.from)
    delete overrides.from

    const delegateTypeBytes = stringToBytes32(delegateType)
    const addDelegateTx = await contract.functions.addDelegate(
      this.address,
      delegateTypeBytes,
      delegateAddress,
      exp,
      overrides
    )
    return await addDelegateTx.wait()
  }

  async createAddDelegateHash(delegateType: string, delegateAddress: address, exp: number) {
    const paddedNonce = await this.getPaddedNonceCompatibility()

    const dataToHash = hexConcat([
      MESSAGE_PREFIX,
      this.contract.address,
      paddedNonce,
      this.address,
      concat([
        toUtf8Bytes('addDelegate'),
        formatBytes32String(delegateType),
        delegateAddress,
        zeroPad(hexlify(exp), 32),
      ]),
    ])
    return keccak256(dataToHash)
  }

  async addDelegateSigned(
    delegateType: string,
    delegateAddress: address,
    exp: number,
    metaSignature: MetaSignature,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }
    const contract = await this.attachContract(overrides.from)
    delete overrides.from

    const delegateTypeBytes = stringToBytes32(delegateType)
    const addDelegateTx = await contract.functions.addDelegateSigned(
      this.address,
      metaSignature.sigV,
      metaSignature.sigR,
      metaSignature.sigS,
      delegateTypeBytes,
      delegateAddress,
      exp,
      overrides
    )
    return await addDelegateTx.wait()
  }

  async revokeDelegate(
    delegateType: string,
    delegateAddress: address,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }
    delegateType = delegateType.startsWith('0x') ? delegateType : stringToBytes32(delegateType)
    const contract = await this.attachContract(overrides.from)
    delete overrides.from
    const addDelegateTx = await contract.functions.revokeDelegate(
      this.address,
      delegateType,
      delegateAddress,
      overrides
    )
    return await addDelegateTx.wait()
  }

  async createRevokeDelegateHash(delegateType: string, delegateAddress: address) {
    const paddedNonce = await this.getPaddedNonceCompatibility()

    const dataToHash = hexConcat([
      MESSAGE_PREFIX,
      this.contract.address,
      paddedNonce,
      this.address,
      concat([toUtf8Bytes('revokeDelegate'), formatBytes32String(delegateType), delegateAddress]),
    ])
    return keccak256(dataToHash)
  }

  async revokeDelegateSigned(
    delegateType: string,
    delegateAddress: address,
    metaSignature: MetaSignature,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }
    delegateType = delegateType.startsWith('0x') ? delegateType : stringToBytes32(delegateType)
    const contract = await this.attachContract(overrides.from)
    delete overrides.from
    const addDelegateTx = await contract.functions.revokeDelegateSigned(
      this.address,
      metaSignature.sigV,
      metaSignature.sigR,
      metaSignature.sigS,
      delegateType,
      delegateAddress,
      overrides
    )
    return await addDelegateTx.wait()
  }

  async setAttribute(
    attrName: string,
    attrValue: string,
    exp: number,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      controller: undefined,
      ...options,
    }
    attrName = attrName.startsWith('0x') ? attrName : stringToBytes32(attrName)
    attrValue = attrValue.startsWith('0x') ? attrValue : '0x' + Buffer.from(attrValue, 'utf-8').toString('hex')
    const contract = await this.attachContract(overrides.from)
    delete overrides.from
    const setAttrTx = await contract.functions.setAttribute(this.address, attrName, attrValue, exp, overrides)
    return await setAttrTx.wait()
  }

  async createSetAttributeHash(attrName: string, attrValue: string, exp: number) {
    const paddedNonce = await this.getPaddedNonceCompatibility(true)

    const dataToHash = hexConcat([
      MESSAGE_PREFIX,
      this.contract.address,
      paddedNonce,
      this.address,
      concat([
        toUtf8Bytes('setAttribute'),
        formatBytes32String(attrName),
        toUtf8Bytes(attrValue),
        zeroPad(hexlify(exp), 32),
      ]),
    ])
    return keccak256(dataToHash)
  }

  async setAttributeSigned(
    attrName: string,
    attrValue: string,
    exp: number,
    metaSignature: MetaSignature,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      controller: undefined,
      ...options,
    }
    attrName = attrName.startsWith('0x') ? attrName : stringToBytes32(attrName)
    attrValue = attrValue.startsWith('0x') ? attrValue : '0x' + Buffer.from(attrValue, 'utf-8').toString('hex')
    const contract = await this.attachContract(overrides.from)
    delete overrides.from
    const setAttrTx = await contract.functions.setAttributeSigned(
      this.address,
      metaSignature.sigV,
      metaSignature.sigR,
      metaSignature.sigS,
      attrName,
      attrValue,
      exp,
      overrides
    )
    return await setAttrTx.wait()
  }

  async revokeAttribute(attrName: string, attrValue: string, options: CallOverrides = {}): Promise<TransactionReceipt> {
    // console.log(`revoking attribute ${attrName}(${attrValue}) for ${identity}`)
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }
    attrName = attrName.startsWith('0x') ? attrName : stringToBytes32(attrName)
    attrValue = attrValue.startsWith('0x') ? attrValue : '0x' + Buffer.from(attrValue, 'utf-8').toString('hex')
    const contract = await this.attachContract(overrides.from)
    delete overrides.from
    const revokeAttributeTX = await contract.functions.revokeAttribute(this.address, attrName, attrValue, overrides)
    return await revokeAttributeTX.wait()
  }

  async createRevokeAttributeHash(attrName: string, attrValue: string) {
    const paddedNonce = await this.getPaddedNonceCompatibility(true)

    const dataToHash = hexConcat([
      MESSAGE_PREFIX,
      this.contract.address,
      paddedNonce,
      this.address,
      concat([toUtf8Bytes('revokeAttribute'), formatBytes32String(attrName), toUtf8Bytes(attrValue)]),
    ])
    return keccak256(dataToHash)
  }

  /**
   * The legacy version of the ethr-did-registry contract tracks the nonce as a property of the original owner, and not
   * as a property of the signer (current owner). That's why we need to differentiate between deployments here, or
   * otherwise our signature will be computed wrong resulting in a failed TX.
   *
   * Not only that, but the nonce is loaded differently for [set/revoke]AttributeSigned methods.
   */
  private async getPaddedNonceCompatibility(attribute = false) {
    let nonceKey
    if (this.legacyNonce && attribute) {
      nonceKey = this.address
    } else {
      nonceKey = await this.getOwner(this.address)
    }
    return zeroPad(arrayify(await this.contract.nonce(nonceKey)), 32)
  }

  async revokeAttributeSigned(
    attrName: string,
    attrValue: string,
    metaSignature: MetaSignature,
    options: CallOverrides = {}
  ): Promise<TransactionReceipt> {
    // console.log(`revoking attribute ${attrName}(${attrValue}) for ${identity}`)
    const overrides = {
      gasLimit: 123456,
      gasPrice: 1000000000,
      ...options,
    }
    attrName = attrName.startsWith('0x') ? attrName : stringToBytes32(attrName)
    attrValue = attrValue.startsWith('0x') ? attrValue : '0x' + Buffer.from(attrValue, 'utf-8').toString('hex')
    const contract = await this.attachContract(overrides.from)
    delete overrides.from
    const revokeAttributeTX = await contract.functions.revokeAttributeSigned(
      this.address,
      metaSignature.sigV,
      metaSignature.sigR,
      metaSignature.sigS,
      attrName,
      attrValue,
      overrides
    )
    return await revokeAttributeTX.wait()
  }
}
