import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnOutput }  from 'aws-cdk-lib';
import { Vpc, SubnetType, IpAddresses, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { Cluster, AlbControllerVersion, AuthenticationMode, KubernetesVersion } from 'aws-cdk-lib/aws-eks';
import { Role, PolicyDocument, ServicePrincipal, CompositePrincipal, AccountRootPrincipal, ManagedPolicy, PolicyStatement, } from 'aws-cdk-lib/aws-iam';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';
import * as fs from 'fs';
import * as path from 'path';

// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class CdkStack extends cdk.Stack {

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    
    
    // EKS Cluster needs public and private subnet to initialize
    const vpc = new Vpc(this, 'DemoVPC', {
      ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateEgressSubnet',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
      natGateways: 1,
    });

    // Output the VPC and subnet IDs
    new CfnOutput(this, 'PetClinicEksVPCID', {
      value: vpc.vpcId,
      description: 'VPC ID',
      exportName: 'EksVPCID',
    });

    this.createEksCluster(id, vpc);



  }

  createEksCluster(id: string, vpc: Vpc) {
    const cluster = new Cluster(this, 'EKSCluster', {
      clusterName: "TrueWatch-demo-cluster", 
      version: KubernetesVersion.V1_31,
      mastersRole: this.createEksMasterRoles(id),
      authenticationMode: AuthenticationMode.API_AND_CONFIG_MAP,
      vpc: vpc,
      defaultCapacity: 0,
      // Make sure this version matches the this.clusterKubernetesVersion
      kubectlLayer: new KubectlV31Layer(this, 'kubectl'),
      albController: {
        version: AlbControllerVersion.V2_8_2,
        policy: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'iam', 'alb-ingress-controller-policy.json'), 'utf8'))
      },
    });

    // Retrieve the latest node group ami. This will ensure that the ami doesn't expire for long live instances
    // const nodeGroupAmiReleaseVersion = StringParameter.valueForStringParameter(
    //   this,
    //   `/aws/service/eks/optimized-ami/${this.clusterKubernetesVersion.version}/amazon-linux-2/recommended/release_version`,
    // );

    // Need at least 3 nodes to support all the pods for the sample app. Alternative is to upgrade the instance type
    // that can support more pods at once
    cluster.addNodegroupCapacity('SampleAppNodeGroup', {
      nodeRole: this.createEksNodeGroupRole(id),
      instanceTypes: [
        new InstanceType('t3.large'),
      ],
      minSize: 4, 
      maxSize: 10,
    });
    
    return cluster;
  }

  createEksMasterRoles(id: string) {
    const eksClusterRoleProp = {
      roleName: `${id}-PetClinicEksClusterRole`,
      assumedBy: new CompositePrincipal(
        new ServicePrincipal('eks.amazonaws.com'),
        new AccountRootPrincipal(),
      ),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSServicePolicy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
      // Need this policy to assume role and debug the cluster
      inlinePolicies: {
        describeClusterPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['eks:DescribeCluster'],
              resources: ['*'],
            }),
          ],
        }),
      },
    };
    return new Role(this, 'EksClusterRole', eksClusterRoleProp)
  }

  createEksNodeGroupRole(id: string) {
    const eksNodeGroupRoleProp = {
      roleName: `${id}-PetClinicEksNodeGroupRole`,
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      inlinePolicies: {
        describeInstancesPolicy: new PolicyDocument({
          statements: [
            new PolicyStatement({
              actions: ['eks-auth:AssumeRoleForPodIdentity'],
              resources: ['*'],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
      ],
    };

    return new Role(this, 'EksNodegruopRole', eksNodeGroupRoleProp);
  }
}
